const express = require('express');
const prisma = require('../lib/prisma');
const nomba = require('../services/nomba');
const { requireAuth, requireSupplier } = require('../middleware/auth');
const { ensureInviteCode } = require('../services/supplierInvites');
const {
  isSupplierKycComplete,
  assertSupplierKycComplete,
  toPublicSupplierUser,
} = require('../lib/kyc');

const router = express.Router();

router.use(requireAuth, requireSupplier);

async function syncVerifiedBankToTraderRelationships(supplierUser) {
  if (!supplierUser?.id || !supplierUser.accountNameVerified || !supplierUser.bankCode || !supplierUser.accountNumber) {
    return;
  }

  const bankSync = {
    bankCode: supplierUser.bankCode,
    bankName: supplierUser.bankName,
    accountNumber: supplierUser.accountNumber,
    resolvedAccountName: supplierUser.resolvedAccountName,
    accountNameVerified: true,
  };

  await prisma.supplier.updateMany({
    where: { supplierUserId: supplierUser.id, archivedAt: null },
    data: bankSync,
  });

  await prisma.supplier.updateMany({
    where: {
      phone: supplierUser.phone,
      supplierUserId: null,
      archivedAt: null,
    },
    data: {
      ...bankSync,
      supplierUserId: supplierUser.id,
    },
  });
}

// GET /api/supplier-dashboard/profile — this supplier's own invite/profile data
router.get('/profile', async (req, res) => {
  try {
    const supplierUser = await prisma.supplierUser.findUnique({ where: { id: req.auth.id } });
    if (!supplierUser) return res.status(404).json({ error: 'Profile not found' });

    await syncVerifiedBankToTraderRelationships(supplierUser);
    res.json({ data: toPublicSupplierUser(supplierUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// POST /api/supplier-dashboard/resolve-name — Nomba lookup, then persist + sync trader rows
router.post('/resolve-name', async (req, res) => {
  const { accountNumber, bankCode, bankName } = req.body;
  if (!accountNumber?.trim() || !bankCode) {
    return res.status(400).json({ error: 'accountNumber and bankCode are required' });
  }
  try {
    const result = await nomba.resolveAccountName({ accountNumber: accountNumber.trim(), bankCode });
    if (!result?.accountName || !result.verified) {
      return res.status(400).json({ error: 'Could not verify this bank account. Check the number and bank.' });
    }

    const supplierUser = await prisma.supplierUser.update({
      where: { id: req.auth.id },
      data: {
        accountNumber: accountNumber.trim(),
        bankCode,
        ...(bankName !== undefined ? { bankName: bankName || null } : {}),
        resolvedAccountName: result.accountName,
        accountNameVerified: true,
      },
    });

    await syncVerifiedBankToTraderRelationships(supplierUser);

    res.json({ data: { accountName: result.accountName, verified: true, kycComplete: isSupplierKycComplete(supplierUser) } });
  } catch (err) {
    console.error('Supplier resolve-name error:', err?.message || err);
    res.status(400).json({ error: err?.message || 'Failed to resolve account name' });
  }
});

// PATCH /api/supplier-dashboard/profile — business name, BVN, self-verified bank details
router.patch('/profile', async (req, res) => {
  const {
    businessName, bvn, bankCode, bankName, accountNumber,
    resolvedAccountName, accountNameVerified,
    suggestedMode, suggestedAllocationPct,
  } = req.body;

  const data = {};
  if (businessName !== undefined) data.businessName = businessName?.trim() || null;
  if (bvn !== undefined) {
    if (!bvn || !/^\d{11}$/.test(bvn)) {
      return res.status(400).json({ error: 'BVN must be exactly 11 digits' });
    }
    data.bvn = bvn;
  }
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
    const existing = await prisma.supplierUser.findUnique({ where: { id: req.auth.id } });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });

    // Re-verify via Nomba whenever bank details are being saved — never trust client flags alone.
    const nextBankCode = data.bankCode !== undefined ? data.bankCode : existing.bankCode;
    const nextAccountNumber = data.accountNumber !== undefined ? data.accountNumber : existing.accountNumber;
    if (data.bankCode !== undefined || data.accountNumber !== undefined) {
      if (!nextBankCode || !nextAccountNumber) {
        return res.status(400).json({ error: 'bankCode and accountNumber are required' });
      }
      try {
        const lookup = await nomba.resolveAccountName({
          accountNumber: nextAccountNumber,
          bankCode: nextBankCode,
        });
        if (!lookup?.accountName || !lookup.verified) {
          return res.status(400).json({
            error: 'Could not verify this bank account. Check the number and bank, then verify again.',
          });
        }
        data.resolvedAccountName = lookup.accountName;
        data.accountNameVerified = true;
      } catch (lookupErr) {
        console.error('Supplier profile bank re-verify failed:', lookupErr?.message || lookupErr);
        return res.status(400).json({
          error: lookupErr?.message || 'Could not verify this bank account. Try again.',
        });
      }
    }

    const prospective = { ...existing, ...data };
    if (prospective.bvn && prospective.bankCode && prospective.accountNumber && prospective.accountNameVerified) {
      data.kycStatus = 'submitted';
      prospective.kycStatus = 'submitted';
    }

    if (prospective.suggestedMode === 'credit_repayment') {
      try {
        assertSupplierKycComplete(prospective, 'Complete KYC before offering credit repayment terms');
      } catch (err) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
    }

    let supplierUser = await prisma.supplierUser.update({ where: { id: req.auth.id }, data });

    if (isSupplierKycComplete(supplierUser) && supplierUser.businessName) {
      supplierUser = await ensureInviteCode(req.auth.id);
    }

    // Keep trader-facing Supplier rows in sync (they own the Unverified badge).
    await syncVerifiedBankToTraderRelationships(supplierUser);

    res.json({ data: toPublicSupplierUser(supplierUser) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
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
        creditLedger: { include: { creditLifePolicy: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ data: suppliers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch relationships' });
  }
});

// GET /api/supplier-dashboard/wallet-balance — total credit repaid across all relationships
router.get('/wallet-balance', async (req, res) => {
  try {
    const result = await prisma.creditLedger.aggregate({
      where: { supplier: { supplierUserId: req.auth.id, archivedAt: null } },
      _sum: { totalRepaid: true },
    });
    res.json({ data: { balance: result._sum.totalRepaid || 0 } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch wallet balance' });
  }
});

// GET /api/supplier-dashboard/relationships/:supplierId — full detail for one trader relationship
router.get('/relationships/:supplierId', async (req, res) => {
  try {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.supplierId },
      include: {
        trader: { select: { id: true, name: true, business: true, market: true, avatar: true } },
        creditLedger: { include: { creditLifePolicy: true } },
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
