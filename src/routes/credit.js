const express = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { requireAuth, requireTrader, requireSupplier } = require('../middleware/auth');
const { emitToSupplierUser, emitToTrader } = require('../services/split');
const { assertKycComplete, assertSupplierKycComplete } = require('../lib/kyc');
const mycover = require('../services/mycover');
const creditSetupFees = require('../services/creditSetupFees');
const nomba = require('../services/nomba');

const router = express.Router();

function generateShareToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function loadSupplierForTrader(supplierId, traderId) {
  const supplier = await prisma.supplier.findUnique({
    where: { id: supplierId },
    include: {
      creditLedger: { include: { creditLifePolicy: true } },
      collateralProfile: true,
      supplierUser: true,
    },
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
    const trader = await prisma.trader.findUnique({ where: { id: req.auth.id } });
    if (!trader) return res.status(404).json({ error: 'Trader not found' });
    assertKycComplete(trader, 'Complete KYC to take supplier credit');

    const supplier = await loadSupplierForTrader(supplierId, req.auth.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    if (supplier.mode !== 'credit_repayment') {
      return res.status(400).json({ error: 'Supplier must be on Credit Repayment mode to log a credit entry' });
    }
    assertSupplierKycComplete(
      supplier.supplierUser,
      'This supplier must sign in and complete KYC before you can take credit from them',
    );

    let ledger;
    if (supplier.creditLedger && supplier.creditLedger.status === 'active') {
      // Top up an existing active credit line.
      const nextAmount = supplier.creditLedger.creditAmount + amount;
      const feeFields = creditSetupFees.feeFieldsForCreditAmount(nextAmount, supplier.creditLedger);
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
          ...feeFields,
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

      const feeFields = creditSetupFees.feeFieldsForCreditAmount(amount);
      ledger = await prisma.creditLedger.create({
        data: {
          supplierId, creditAmount: amount, outstandingBalance: amount, note, terms,
          dueDate: dueDate !== undefined ? parsedDueDate : null,
          status: 'active', confirmationStatus: 'pending',
          collateralProfileId: supplier.collateralProfile?.id,
          ...feeFields,
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
    if (err.status === 403 && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
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
      include: { supplier: { include: { supplierUser: true } } },
    });
    if (!ledger || ledger.supplier.supplierUserId !== req.auth.id) {
      return res.status(404).json({ error: 'Credit entry not found' });
    }
    try {
      assertSupplierKycComplete(ledger.supplier.supplierUser, 'Complete KYC before confirming goods handover');
    } catch (err) {
      return res.status(err.status).json({ error: err.message, code: err.code });
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
      include: {
        creditLifePolicy: true,
        supplier: { include: { trader: true, collateralProfile: true, supplierUser: true } },
      },
    });
    if (!ledger || ledger.supplier.supplierUserId !== req.auth.id) {
      return res.status(404).json({ error: 'Credit entry not found' });
    }

    if (status === 'confirmed') {
      try {
        assertSupplierKycComplete(ledger.supplier.supplierUser, 'Complete KYC before confirming this credit entry');
      } catch (err) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
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

      if (!mycover.isCovering(ledger.creditLifePolicy, ledger.creditAmount)) {
        return res.status(403).json({
          error: 'Buy Credit Life cover before confirming this credit entry',
          code: 'CREDIT_LIFE_REQUIRED',
        });
      }

      // Backfill fee amount on older ledgers that predate supplier-paid setup fees
      let feeLedger = ledger;
      if (!(ledger.platformSetupFeeAmount > 0) && ledger.creditAmount > 0) {
        const feeFields = creditSetupFees.feeFieldsForCreditAmount(ledger.creditAmount, ledger);
        feeLedger = await prisma.creditLedger.update({
          where: { id: ledger.id },
          data: feeFields,
        });
      }

      if (!creditSetupFees.isPlatformFeeSatisfied(feeLedger)) {
        return res.status(403).json({
          error: 'Pay or accept the MarketPay credit setup fee before confirming',
          code: 'SETUP_FEE_REQUIRED',
          setupQuote: creditSetupFees.computeQuote(ledger.creditAmount),
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

// POST /api/credit/entries/:ledgerId/pay-setup-fee — supplier pays MarketPay % of creditAmount
// body: { method: 'held_balance' | 'accrue' | 'simulate' }
router.post('/entries/:ledgerId/pay-setup-fee', requireAuth, requireSupplier, async (req, res) => {
  const { ledgerId } = req.params;
  const method = req.body?.method || 'accrue';
  if (!['held_balance', 'accrue', 'simulate'].includes(method)) {
    return res.status(400).json({ error: 'method must be held_balance, accrue, or simulate' });
  }

  try {
    const ledger = await prisma.creditLedger.findUnique({
      where: { id: ledgerId },
      include: { supplier: { include: { supplierUser: true } } },
    });
    if (!ledger || ledger.supplier.supplierUserId !== req.auth.id) {
      return res.status(404).json({ error: 'Credit entry not found' });
    }

    try {
      assertSupplierKycComplete(ledger.supplier.supplierUser, 'Complete KYC before paying credit setup fees');
    } catch (err) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }

    const quote = creditSetupFees.computeQuote(ledger.creditAmount);
    const remaining = Math.max(0, quote.platformSetupFee - (ledger.platformSetupFeeCollected || 0));

    if (remaining <= 0 || creditSetupFees.isPlatformFeeSatisfied({ ...ledger, platformSetupFeeAmount: quote.platformSetupFee })) {
      const paid = await prisma.creditLedger.update({
        where: { id: ledgerId },
        data: {
          platformSetupFeeAmount: quote.platformSetupFee,
          platformSetupFeeStatus: 'paid',
          platformSetupFeePaidAt: ledger.platformSetupFeePaidAt || new Date(),
        },
      });
      return res.json({
        data: paid,
        setupQuote: { ...quote, platformSetupFeeCollected: paid.platformSetupFeeCollected, platformSetupFeeRemaining: 0 },
      });
    }

    if (method === 'simulate') {
      if (process.env.USE_STUB_ACCOUNTS !== 'true' && process.env.NODE_ENV === 'production') {
        return res.status(404).json({ error: 'Not found' });
      }
      const updated = await prisma.creditLedger.update({
        where: { id: ledgerId },
        data: {
          platformSetupFeeAmount: quote.platformSetupFee,
          platformSetupFeeCollected: quote.platformSetupFee,
          platformSetupFeeStatus: 'paid',
          platformSetupFeePaidAt: new Date(),
          platformSetupFeeMethod: 'simulate',
        },
      });
      await prisma.creditLedgerEvent.create({
        data: {
          creditLedgerId: ledgerId,
          eventType: 'setup_fee_paid',
          newAmount: quote.platformSetupFee,
          note: 'Simulated MarketPay credit setup fee',
          actor: 'supplier',
        },
      });
      return res.json({
        data: updated,
        setupQuote: { ...quote, platformSetupFeeCollected: quote.platformSetupFee, platformSetupFeeRemaining: 0 },
      });
    }

    if (method === 'held_balance') {
      if (ledger.supplier.heldBalance < remaining) {
        return res.status(409).json({
          error: `Held balance (${ledger.supplier.heldBalance}) is less than the fee remaining (${remaining}). Choose accrue from future repayments instead.`,
          code: 'INSUFFICIENT_HELD_BALANCE',
          heldBalance: ledger.supplier.heldBalance,
          feeRemaining: remaining,
        });
      }

      if (process.env.PLATFORM_FEE_ACCOUNT_ID && ledger.supplier.virtualAccountId) {
        try {
          await nomba.initiateTransfer({
            from: ledger.supplier.virtualAccountId,
            to: process.env.PLATFORM_FEE_ACCOUNT_ID,
            amount: remaining,
            reference: `${ledgerId}-setup-fee-${Date.now()}`,
          });
        } catch (err) {
          console.error('Setup fee transfer failed:', err?.response?.data || err.message);
          return res.status(502).json({ error: 'Could not transfer setup fee from held balance' });
        }
      }

      await prisma.supplier.update({
        where: { id: ledger.supplier.id },
        data: { heldBalance: { decrement: remaining } },
      });

      const updated = await prisma.creditLedger.update({
        where: { id: ledgerId },
        data: {
          platformSetupFeeAmount: quote.platformSetupFee,
          platformSetupFeeCollected: quote.platformSetupFee,
          platformSetupFeeStatus: 'paid',
          platformSetupFeePaidAt: new Date(),
          platformSetupFeeMethod: 'held_balance',
        },
      });
      await prisma.creditLedgerEvent.create({
        data: {
          creditLedgerId: ledgerId,
          eventType: 'setup_fee_paid',
          newAmount: remaining,
          note: 'MarketPay credit setup fee from held balance',
          actor: 'supplier',
        },
      });
      emitToTrader(ledger.supplier.traderId, { type: 'credit_ledger_updated', supplierId: ledger.supplier.id });
      return res.json({
        data: updated,
        setupQuote: { ...quote, platformSetupFeeCollected: quote.platformSetupFee, platformSetupFeeRemaining: 0 },
      });
    }

    // accrue — recover from future restock/credit repayment splits
    const updated = await prisma.creditLedger.update({
      where: { id: ledgerId },
      data: {
        platformSetupFeeAmount: quote.platformSetupFee,
        platformSetupFeeStatus: 'accruing',
        platformSetupFeeMethod: 'accrue',
      },
    });
    await prisma.creditLedgerEvent.create({
      data: {
        creditLedgerId: ledgerId,
        eventType: 'setup_fee_accruing',
        newAmount: remaining,
        note: `MarketPay ${creditSetupFees.CREDIT_SETUP_FEE_PCT}% fee will be deducted from future repayments`,
        actor: 'supplier',
      },
    });
    emitToTrader(ledger.supplier.traderId, { type: 'credit_ledger_updated', supplierId: ledger.supplier.id });
    res.json({
      data: updated,
      setupQuote: {
        ...quote,
        platformSetupFeeCollected: updated.platformSetupFeeCollected,
        platformSetupFeeRemaining: remaining,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process setup fee' });
  }
});

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

    const feeFields = creditSetupFees.feeFieldsForCreditAmount(correctedAmount, ledger);
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
        ...feeFields,
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
