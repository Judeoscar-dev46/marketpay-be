const express = require('express');
const prisma = require('../lib/prisma');
const nomba = require('../services/nomba');
const { requireAuth, requireTrader, requireSupplier } = require('../middleware/auth');

const USE_STUB = process.env.USE_STUB_ACCOUNTS === 'true' || !process.env.NOMBA_CLIENT_ID;
const MAX_SUPPLIERS = 3;

const router = express.Router();

function activeSupplierWhere(traderId) {
  return { traderId, archivedAt: null };
}

async function makeSubAccount({ traderName, supplierName, ref }) {
  if (USE_STUB) {
    return {
      accountId: `stub-${ref}`,
      accountNumber: `00${Math.floor(10000000 + Math.random() * 90000000)}`,
    };
  }
  return nomba.createVirtualAccount({ name: `${traderName} — ${supplierName}`, reference: ref });
}

// POST /api/suppliers/resolve-name — preview the real bank account name before saving a supplier
router.post('/resolve-name', requireAuth, requireTrader, async (req, res) => {
  const { accountNumber, bankCode } = req.body;
  if (!accountNumber?.trim() || !bankCode) {
    return res.status(400).json({ error: 'accountNumber and bankCode are required' });
  }
  try {
    const result = await nomba.resolveAccountName({ accountNumber: accountNumber.trim(), bankCode });
    res.json({ data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve account name' });
  }
});

// GET /api/suppliers — this trader's suppliers
router.get('/', requireAuth, requireTrader, async (req, res) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      where: activeSupplierWhere(req.auth.id),
      include: { creditLedger: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ data: suppliers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch suppliers' });
  }
});

// POST /api/suppliers — add a supplier
router.post('/', requireAuth, requireTrader, async (req, res) => {
  const {
    name, phone, bankCode, bankName, accountNumber,
    resolvedAccountName, accountNameVerified,
    mode, allocationPct, payoutSchedule,
  } = req.body;
  const traderId = req.auth.id;

  if (!name?.trim() || !phone?.trim() || !bankCode || !accountNumber?.trim()) {
    return res.status(400).json({ error: 'name, phone, bankCode, and accountNumber are required' });
  }
  if (!Number.isInteger(allocationPct) || allocationPct < 1 || allocationPct > 99) {
    return res.status(400).json({ error: 'allocationPct must be an integer between 1 and 99' });
  }
  if (!['restock', 'credit_repayment'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be restock or credit_repayment' });
  }
  const schedule = ['immediate', 'daily', 'weekly'].includes(payoutSchedule) ? payoutSchedule : 'immediate';

  try {
    const trader = await prisma.trader.findUnique({ where: { id: traderId } });
    if (!trader) return res.status(404).json({ error: 'Trader not found' });

    const existing = await prisma.supplier.findMany({ where: activeSupplierWhere(traderId) });
    if (existing.length >= MAX_SUPPLIERS) {
      return res.status(400).json({ error: `Maximum of ${MAX_SUPPLIERS} suppliers reached` });
    }
    const allocatedSoFar = existing.reduce((sum, s) => sum + s.allocationPct, 0);
    if (allocatedSoFar + allocationPct > trader.supplierPct) {
      return res.status(400).json({
        error: `Allocation exceeds available supplier split — ${trader.supplierPct - allocatedSoFar}% remaining. Adjust Split Settings first if you need more.`,
      });
    }

    let virtualAccountId = null;
    let virtualAccountNumber = null;
    if (schedule !== 'immediate') {
      const va = await makeSubAccount({
        traderName: trader.name,
        supplierName: name.trim(),
        ref: `${traderId}-supplier-${Date.now()}`,
      });
      virtualAccountId = va.accountId;
      virtualAccountNumber = va.accountNumber;
    }

    // Matching by phone alone never implies the supplier has accepted this relationship.
    const supplierUser = await prisma.supplierUser.findUnique({ where: { phone: phone.trim() } });

    const supplier = await prisma.supplier.create({
      data: {
        traderId,
        name: name.trim(),
        phone: phone.trim(),
        bankCode,
        bankName: bankName || null,
        accountNumber: accountNumber.trim(),
        resolvedAccountName: resolvedAccountName || null,
        accountNameVerified: !!accountNameVerified,
        mode,
        allocationPct,
        payoutSchedule: schedule,
        virtualAccountId,
        virtualAccountNumber,
        supplierUserId: supplierUser?.id || null,
      },
    });

    res.status(201).json({ data: supplier });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add supplier' });
  }
});

// PATCH /api/suppliers/:id — allocation/mode/schedule changes take effect next sale only
router.patch('/:id', requireAuth, requireTrader, async (req, res) => {
  const { id } = req.params;
  const { allocationPct, mode, payoutSchedule, restockFallbackPct } = req.body;

  try {
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier || supplier.traderId !== req.auth.id) return res.status(404).json({ error: 'Supplier not found' });

    const trader = await prisma.trader.findUnique({ where: { id: req.auth.id } });
    const data = {};

    if (allocationPct !== undefined) {
      if (!Number.isInteger(allocationPct) || allocationPct < 1 || allocationPct > 99) {
        return res.status(400).json({ error: 'allocationPct must be an integer between 1 and 99' });
      }
      const others = await prisma.supplier.findMany({
        where: { ...activeSupplierWhere(req.auth.id), id: { not: id } },
      });
      const allocatedByOthers = others.reduce((sum, s) => sum + s.allocationPct, 0);
      if (allocatedByOthers + allocationPct > trader.supplierPct) {
        return res.status(400).json({
          error: `Allocation exceeds available supplier split — ${trader.supplierPct - allocatedByOthers}% remaining`,
        });
      }
      data.allocationPct = allocationPct;
    }

    if (mode !== undefined) {
      if (!['restock', 'credit_repayment'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
      data.mode = mode;
    }

    if (payoutSchedule !== undefined) {
      if (!['immediate', 'daily', 'weekly'].includes(payoutSchedule)) {
        return res.status(400).json({ error: 'Invalid payoutSchedule' });
      }
      data.payoutSchedule = payoutSchedule;
      if (payoutSchedule !== 'immediate' && !supplier.virtualAccountId) {
        const va = await makeSubAccount({
          traderName: trader.name,
          supplierName: supplier.name,
          ref: `${req.auth.id}-supplier-${id}-${Date.now()}`,
        });
        data.virtualAccountId = va.accountId;
        data.virtualAccountNumber = va.accountNumber;
      }
    }

    if (restockFallbackPct !== undefined) data.restockFallbackPct = restockFallbackPct;

    const updated = await prisma.supplier.update({ where: { id }, data });
    res.json({ data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update supplier' });
  }
});

// DELETE /api/suppliers/:id — soft-delete, preserves credit ledger/repayment history
router.delete('/:id', requireAuth, requireTrader, async (req, res) => {
  const { id } = req.params;
  try {
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier || supplier.traderId !== req.auth.id) return res.status(404).json({ error: 'Supplier not found' });
    const archived = await prisma.supplier.update({ where: { id }, data: { archivedAt: new Date() } });
    res.json({ data: archived });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove supplier' });
  }
});

// POST /api/suppliers/:id/accept-relationship — supplier confirms they recognize this trader
router.post('/:id/accept-relationship', requireAuth, requireSupplier, (req, res) =>
  setRelationshipStatus(req, res, 'accepted')
);

// POST /api/suppliers/:id/dispute-relationship — supplier says they don't recognize this trader
router.post('/:id/dispute-relationship', requireAuth, requireSupplier, (req, res) =>
  setRelationshipStatus(req, res, 'disputed')
);

async function setRelationshipStatus(req, res, status) {
  const { id } = req.params;
  try {
    const supplier = await prisma.supplier.findUnique({ where: { id } });
    if (!supplier || supplier.supplierUserId !== req.auth.id) {
      return res.status(404).json({ error: 'Relationship not found' });
    }
    const updated = await prisma.supplier.update({ where: { id }, data: { relationshipStatus: status } });
    res.json({ data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update relationship status' });
  }
}

module.exports = router;
