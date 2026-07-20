const express = require('express');
const prisma = require('../lib/prisma');
const { requireAuth, requireTrader, requireSupplier } = require('../middleware/auth');
const { emitToSupplierUser, emitToTrader } = require('../services/split');

const router = express.Router();

async function loadSupplierForTrader(supplierId, traderId) {
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId }, include: { creditLedger: true } });
  if (!supplier || supplier.traderId !== traderId) return null;
  return supplier;
}

// POST /api/credit/entries — { supplierId, amount, note } — log (or top up) a credit entry
router.post('/entries', requireAuth, requireTrader, async (req, res) => {
  const { supplierId, amount, note } = req.body;
  if (!supplierId || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'supplierId and a positive integer amount (kobo) are required' });
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
        },
      });
      await prisma.creditLedgerEvent.create({
        data: { creditLedgerId: ledger.id, eventType: 'created', newAmount: amount, note, actor: 'trader' },
      });
    } else {
      ledger = await prisma.creditLedger.create({
        data: { supplierId, creditAmount: amount, outstandingBalance: amount, note, status: 'active', confirmationStatus: 'pending' },
      });
      await prisma.creditLedgerEvent.create({
        data: { creditLedgerId: ledger.id, eventType: 'created', newAmount: amount, note, actor: 'trader' },
      });
    }

    if (supplier.supplierUserId) {
      emitToSupplierUser(supplier.supplierUserId, { type: 'credit_entry', supplierId: supplier.id });
    }

    res.status(201).json({ data: ledger });
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

async function setConfirmationStatus(req, res, status) {
  const { ledgerId } = req.params;
  try {
    const ledger = await prisma.creditLedger.findUnique({ where: { id: ledgerId }, include: { supplier: true } });
    if (!ledger || ledger.supplier.supplierUserId !== req.auth.id) {
      return res.status(404).json({ error: 'Credit entry not found' });
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

    emitToTrader(ledger.supplier.traderId, { type: 'credit_ledger_updated', supplierId: ledger.supplier.id, status });
    res.json({ data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update credit entry' });
  }
}

// POST /api/credit/entries/:ledgerId/correct — trader corrects the credit amount after a dispute
router.post('/entries/:ledgerId/correct', requireAuth, requireTrader, async (req, res) => {
  const { ledgerId } = req.params;
  const { correctedAmount, note } = req.body;
  if (!Number.isInteger(correctedAmount) || correctedAmount < 0) {
    return res.status(400).json({ error: 'correctedAmount (kobo) is required' });
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
        confirmationStatus: 'pending',
        note: note || ledger.note,
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
