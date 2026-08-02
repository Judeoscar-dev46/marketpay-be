const express = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { requireAuth, requireTrader, requireSupplier } = require('../middleware/auth');
const { emitToSupplierUser, emitToTrader } = require('../services/split');

const router = express.Router();

function generateShareToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function loadSupplierForTrader(supplierId, traderId) {
  const supplier = await prisma.supplier.findUnique({
    where: { id: supplierId },
    include: { creditLedger: true, collateralProfile: true },
  });
  if (!supplier || supplier.traderId !== traderId) return null;
  return supplier;
}

// POST /api/credit/entries — { supplierId, amount, note, terms, dueDate } — log (or top up) a credit entry
router.post('/entries', requireAuth, requireTrader, async (req, res) => {
  const { supplierId, amount, note, terms, dueDate } = req.body;
  if (!supplierId || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'supplierId and a positive integer amount (kobo) are required' });
  }
  let parsedDueDate;
  if (dueDate !== undefined) {
    parsedDueDate = new Date(dueDate);
    if (isNaN(parsedDueDate.getTime())) return res.status(400).json({ error: 'dueDate is not a valid date' });
  }

  try {
    const supplier = await loadSupplierForTrader(supplierId, req.auth.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    if (supplier.mode !== 'credit_repayment') {
      return res.status(400).json({ error: 'Supplier must be on Credit Repayment mode to log a credit entry' });
    }

    let ledger;
    if (supplier.creditLedger && supplier.creditLedger.status === 'active') {
      // Top up an existing active credit line.
      ledger = await prisma.creditLedger.update({
        where: { id: supplier.creditLedger.id },
        data: {
          creditAmount: { increment: amount },
          outstandingBalance: { increment: amount },
          confirmationStatus: 'pending',
          note: note || supplier.creditLedger.note,
          terms: terms || supplier.creditLedger.terms,
          dueDate: dueDate !== undefined ? parsedDueDate : supplier.creditLedger.dueDate,
          collateralProfileId: supplier.creditLedger.collateralProfileId || supplier.collateralProfile?.id,
        },
      });
      await prisma.creditLedgerEvent.create({
        data: { creditLedgerId: ledger.id, eventType: 'created', newAmount: amount, note, actor: 'trader' },
      });
    } else {
      // Brand-new credit line — a trader can only owe ONE supplier via credit at a time.
      const conflicting = await prisma.creditLedger.findFirst({
        where: {
          status: { in: ['active', 'disputed'] },
          supplier: { traderId: req.auth.id, id: { not: supplierId } },
        },
        include: { supplier: { select: { name: true } } },
      });
      if (conflicting) {
        return res.status(409).json({
          error: `${conflicting.supplier.name} already has an open credit ledger. Clear or resolve it before starting a new one.`,
          code: 'ANOTHER_SUPPLIER_HAS_ACTIVE_LEDGER',
          conflictingSupplierId: conflicting.supplierId,
        });
      }

      ledger = await prisma.creditLedger.create({
        data: {
          supplierId, creditAmount: amount, outstandingBalance: amount, note, terms,
          dueDate: dueDate !== undefined ? parsedDueDate : null,
          status: 'active', confirmationStatus: 'pending',
          collateralProfileId: supplier.collateralProfile?.id,
        },
      });
      await prisma.creditLedgerEvent.create({
        data: { creditLedgerId: ledger.id, eventType: 'created', newAmount: amount, note, actor: 'trader' },
      });
    }

    if (supplier.supplierUserId) {
      emitToSupplierUser(supplier.supplierUserId, { type: 'credit_entry', supplierId: supplier.id });
    }

    // Advisory only — informational, does not block or gate the amount above.
    res.status(201).json({
      data: ledger,
      collateral: supplier.collateralProfile
        ? { eligible: supplier.collateralProfile.eligible, suggestedCeiling: supplier.collateralProfile.suggestedCeiling }
        : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to log credit entry' });
  }
});

// POST /api/credit/entries/:ledgerId/confirm — supplier confirms the credit amount is correct
router.post('/entries/:ledgerId/confirm', requireAuth, requireSupplier, async (req, res) => {
  await setConfirmationStatus(req, res, 'confirmed');
});

// POST /api/credit/entries/:ledgerId/dispute — supplier disputes the amount; freezes future repayments
router.post('/entries/:ledgerId/dispute', requireAuth, requireSupplier, async (req, res) => {
  await setConfirmationStatus(req, res, 'disputed');
});

// POST /api/credit/entries/:ledgerId/goods-released — supplier marks goods as physically handed
// over. Independent of confirm/dispute — both this and confirmationStatus === 'confirmed' are
// required before split.js will actually route any repayment to this ledger.
router.post('/entries/:ledgerId/goods-released', requireAuth, requireSupplier, async (req, res) => {
  const { ledgerId } = req.params;
  try {
    const ledger = await prisma.creditLedger.findUnique({
      where: { id: ledgerId },
      include: { supplier: true },
    });
    if (!ledger || ledger.supplier.supplierUserId !== req.auth.id) {
      return res.status(404).json({ error: 'Credit entry not found' });
    }
    if (ledger.goodsReleased) {
      return res.json({ data: ledger });
    }

    const updated = await prisma.creditLedger.update({
      where: { id: ledgerId },
      data: { goodsReleased: true, goodsReleasedAt: new Date() },
    });
    await prisma.creditLedgerEvent.create({
      data: { creditLedgerId: ledgerId, eventType: 'goods_released', actor: 'supplier' },
    });

    emitToTrader(ledger.supplier.traderId, { type: 'credit_ledger_updated', supplierId: ledger.supplier.id, goodsReleased: true });
    res.json({ data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark goods released' });
  }
});

async function setConfirmationStatus(req, res, status) {
  const { ledgerId } = req.params;
  try {
    const ledger = await prisma.creditLedger.findUnique({
      where: { id: ledgerId },
      include: { supplier: { include: { trader: true, collateralProfile: true } } },
    });
    if (!ledger || ledger.supplier.supplierUserId !== req.auth.id) {
      return res.status(404).json({ error: 'Credit entry not found' });
    }

    // Collateral must be reviewed before a supplier can CONFIRM (never blocks disputing).
    // Reads the live collateralProfile relation, not the trace-only collateralProfileId FK on
    // the ledger, since that FK is only set opportunistically at creation time and can go
    // stale (e.g. collateral set up after the ledger already existed).
    if (status === 'confirmed') {
      const profile = ledger.supplier.collateralProfile;
      const isOpenLifecycle = profile && (profile.status === 'pending' || profile.status === 'active');
      if (isOpenLifecycle && profile.reviewStatus !== 'approved') {
        return res.status(409).json({
          error: 'Collateral must be reviewed before confirming this credit entry',
          code: 'COLLATERAL_REVIEW_REQUIRED',
          collateralProfileId: profile.id,
        });
      }
    }

    const updated = await prisma.creditLedger.update({
      where: { id: ledgerId },
      data: {
        confirmationStatus: status,
        status: status === 'disputed' ? 'disputed' : ledger.status,
      },
    });
    await prisma.creditLedgerEvent.create({
      data: { creditLedgerId: ledgerId, eventType: status, actor: 'supplier' },
    });

    let shareUrl;
    if (status === 'confirmed') {
      const shareToken = generateShareToken();
      await prisma.creditAgreementSnapshot.create({
        data: {
          creditLedgerId: ledger.id,
          supplierId: ledger.supplier.id,
          traderId: ledger.supplier.traderId,
          creditAmount: updated.creditAmount,
          outstandingBalance: updated.outstandingBalance,
          terms: updated.terms,
          note: updated.note,
          traderName: ledger.supplier.trader.name,
          traderBusiness: ledger.supplier.trader.business,
          supplierName: ledger.supplier.name,
          supplierBankName: ledger.supplier.bankName,
          supplierAccountNumber: ledger.supplier.accountNumber,
          shareToken,
        },
      });
      shareUrl = `/api/credit-agreement/${shareToken}/html`;
    }

    emitToTrader(ledger.supplier.traderId, { type: 'credit_ledger_updated', supplierId: ledger.supplier.id, status, shareUrl });
    if (ledger.supplier.supplierUserId) {
      emitToSupplierUser(ledger.supplier.supplierUserId, { type: 'credit_ledger_updated', supplierId: ledger.supplier.id, status, shareUrl });
    }
    res.json({ data: updated, shareUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update credit entry' });
  }
}

// POST /api/credit/entries/:ledgerId/correct — trader corrects the credit amount after a dispute
router.post('/entries/:ledgerId/correct', requireAuth, requireTrader, async (req, res) => {
  const { ledgerId } = req.params;
  const { correctedAmount, note, terms, dueDate } = req.body;
  if (!Number.isInteger(correctedAmount) || correctedAmount < 0) {
    return res.status(400).json({ error: 'correctedAmount (kobo) is required' });
  }
  let parsedDueDate;
  if (dueDate !== undefined) {
    parsedDueDate = dueDate ? new Date(dueDate) : null;
    if (parsedDueDate && isNaN(parsedDueDate.getTime())) return res.status(400).json({ error: 'dueDate is not a valid date' });
  }

  try {
    const ledger = await prisma.creditLedger.findUnique({ where: { id: ledgerId }, include: { supplier: true } });
    if (!ledger || ledger.supplier.traderId !== req.auth.id) return res.status(404).json({ error: 'Credit entry not found' });

    const newOutstanding = correctedAmount - ledger.totalRepaid;
    const overpaid = newOutstanding < 0;

    const updated = await prisma.creditLedger.update({
      where: { id: ledgerId },
      data: {
        creditAmount: correctedAmount,
        outstandingBalance: Math.max(newOutstanding, 0),
        overpaidAmount: overpaid ? Math.abs(newOutstanding) : 0,
        status: overpaid ? 'overpaid' : 'active',
        dueDate: dueDate !== undefined ? parsedDueDate : ledger.dueDate,
        confirmationStatus: 'pending',
        note: note || ledger.note,
        terms: terms || ledger.terms,
      },
    });

    await prisma.creditLedgerEvent.create({
      data: {
        creditLedgerId: ledgerId,
        eventType: 'corrected',
        previousAmount: ledger.creditAmount,
        newAmount: correctedAmount,
        note,
        actor: 'trader',
      },
    });

    if (ledger.supplier.supplierUserId) {
      emitToSupplierUser(ledger.supplier.supplierUserId, { type: 'credit_ledger_updated', supplierId: ledger.supplier.id });
    }

    res.json({ data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to correct credit entry' });
  }
});

// GET /api/credit/supplier/:supplierId — trader-side detail view
router.get('/supplier/:supplierId', requireAuth, requireTrader, async (req, res) => {
  try {
    const supplier = await loadSupplierForTrader(req.params.supplierId, req.auth.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    if (!supplier.creditLedger) return res.json({ data: null });

    const [repayments, events] = await Promise.all([
      prisma.creditRepayment.findMany({
        where: { creditLedgerId: supplier.creditLedger.id },
        include: { splitTransfer: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.creditLedgerEvent.findMany({
        where: { creditLedgerId: supplier.creditLedger.id },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    res.json({ data: { ledger: supplier.creditLedger, repayments, events } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch credit detail' });
  }
});

module.exports = router;
