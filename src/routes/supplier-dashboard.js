const express = require('express');
const prisma = require('../lib/prisma');
const { requireAuth, requireSupplier } = require('../middleware/auth');
const { ensureInviteCode } = require('../services/supplierInvites');

const router = express.Router();

router.use(requireAuth, requireSupplier);

// GET /api/supplier-dashboard/profile — this supplier's own invite/profile data
router.get('/profile', async (req, res) => {
  try {
    const supplierUser = await prisma.supplierUser.findUnique({ where: { id: req.auth.id } });
    if (!supplierUser) return res.status(404).json({ error: 'Profile not found' });
    res.json({ data: supplierUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PATCH /api/supplier-dashboard/profile — set up business name, self-verified bank details,
// and suggested terms; generates an invite code the first time the required fields are present.
router.patch('/profile', async (req, res) => {
  const {
    businessName, bankCode, bankName, accountNumber,
    resolvedAccountName, accountNameVerified,
    suggestedMode, suggestedAllocationPct,
  } = req.body;

  const data = {};
  if (businessName !== undefined) data.businessName = businessName?.trim() || null;
  if (bankCode !== undefined) data.bankCode = bankCode || null;
  if (bankName !== undefined) data.bankName = bankName || null;
  if (accountNumber !== undefined) data.accountNumber = accountNumber?.trim() || null;
  if (resolvedAccountName !== undefined) data.resolvedAccountName = resolvedAccountName || null;
  if (accountNameVerified !== undefined) data.accountNameVerified = !!accountNameVerified;
  if (suggestedMode !== undefined) {
    if (suggestedMode && !['restock', 'credit_repayment'].includes(suggestedMode)) {
      return res.status(400).json({ error: 'suggestedMode must be restock or credit_repayment' });
    }
    data.suggestedMode = suggestedMode || null;
  }
  if (suggestedAllocationPct !== undefined) {
    if (suggestedAllocationPct !== null && (!Number.isInteger(suggestedAllocationPct) || suggestedAllocationPct < 1 || suggestedAllocationPct > 99)) {
      return res.status(400).json({ error: 'suggestedAllocationPct must be an integer between 1 and 99' });
    }
    data.suggestedAllocationPct = suggestedAllocationPct;
  }

  try {
    let supplierUser = await prisma.supplierUser.update({ where: { id: req.auth.id }, data });

    if (supplierUser.businessName && supplierUser.bankCode && supplierUser.accountNumber) {
      supplierUser = await ensureInviteCode(req.auth.id);
    }

    res.json({ data: supplierUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// GET /api/supplier-dashboard/relationships — every trader relationship for this phone number
router.get('/relationships', async (req, res) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      where: { supplierUserId: req.auth.id, archivedAt: null },
      include: {
        trader: { select: { id: true, name: true, business: true, market: true, avatar: true } },
        creditLedger: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ data: suppliers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch relationships' });
  }
});

// GET /api/supplier-dashboard/relationships/:supplierId — full detail for one trader relationship
router.get('/relationships/:supplierId', async (req, res) => {
  try {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.supplierId },
      include: {
        trader: { select: { id: true, name: true, business: true, market: true, avatar: true } },
        creditLedger: true,
      },
    });
    if (!supplier || supplier.supplierUserId !== req.auth.id) return res.status(404).json({ error: 'Relationship not found' });

    let repayments = [];
    let events = [];
    if (supplier.creditLedger) {
      [repayments, events] = await Promise.all([
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
    }

    res.json({ data: { supplier, repayments, events } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch relationship detail' });
  }
});

module.exports = router;
