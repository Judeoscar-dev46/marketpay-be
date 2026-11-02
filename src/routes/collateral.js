const express = require('express');
const prisma = require('../lib/prisma');
const { requireAuth, requireTrader, requireSupplier } = require('../middleware/auth');
const { emitToSupplierUser, emitToTrader } = require('../services/split');
const collateral = require('../services/collateral');

const router = express.Router();

async function loadProfileForAuth(profileId, req) {
  const profile = await prisma.collateralProfile.findUnique({ where: { id: profileId }, include: { supplier: true } });
  if (!profile) return null;
  const isTrader = profile.traderId === req.auth.id;
  const isSupplier = profile.supplier.supplierUserId === req.auth.id;
  if (!isTrader && !isSupplier) return null;
  return profile;
}

// POST /api/collateral/profile — { supplierId, requestedAmount } — trader posts a collateral ask
router.post('/profile', requireAuth, requireTrader, async (req, res) => {
  const { supplierId, requestedAmount } = req.body;
  try {
    const { profile, collateralAccountNumber } = await collateral.getOrCreateProfile({
      traderId: req.auth.id,
      supplierId,
      requestedAmount,
    });

    const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
    if (supplier?.supplierUserId) {
      emitToSupplierUser(supplier.supplierUserId, { type: 'collateral_updated', supplierId, status: profile.status });
    }

    res.status(201).json({ data: { ...profile, collateralAccountNumber } });
  } catch (err) {
    if (err instanceof collateral.CollateralError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to create collateral profile' });
  }
});

// GET /api/collateral/supplier/:supplierId — profile + events + current score
router.get('/supplier/:supplierId', requireAuth, async (req, res) => {
  try {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.supplierId },
      include: {
        collateralProfile: { include: { events: { orderBy: { createdAt: 'asc' } } } },
        trader: { select: { collateralAccountNumber: true } },
      },
    });
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const isTrader = supplier.traderId === req.auth.id;
    const isSupplier = supplier.supplierUserId === req.auth.id;
    if (!isTrader && !isSupplier) return res.status(404).json({ error: 'Supplier not found' });

    if (!supplier.collateralProfile) return res.json({ data: null });

    res.json({
      data: {
        ...supplier.collateralProfile,
        collateralAccountNumber: supplier.trader.collateralAccountNumber,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch collateral profile' });
  }
});

// PATCH /api/collateral/:profileId — { requestedAmount } — trader corrects the goods-value
// denominator on a still-open profile (pending/active); recomputes the ratio/score afterward
router.patch('/:profileId', requireAuth, requireTrader, async (req, res) => {
  const { requestedAmount } = req.body;
  try {
    const profile = await prisma.collateralProfile.findUnique({ where: { id: req.params.profileId } });
    if (!profile || profile.traderId !== req.auth.id) return res.status(404).json({ error: 'Collateral profile not found' });

    const updated = await collateral.updateRequestedAmount(profile.id, requestedAmount, { actor: 'trader', note: req.body.note });

    const supplier = await prisma.supplier.findUnique({ where: { id: profile.supplierId } });
    if (supplier?.supplierUserId) {
      emitToSupplierUser(supplier.supplierUserId, { type: 'collateral_updated', supplierId: profile.supplierId, status: updated.status });
    }

    res.json({ data: updated });
  } catch (err) {
    if (err instanceof collateral.CollateralError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Failed to update collateral profile' });
  }
});

// POST /api/collateral/:profileId/approve — supplier approves the collateral's current state
router.post('/:profileId/approve', requireAuth, requireSupplier, async (req, res) => {
  try {
    const profile = await loadProfileForAuth(req.params.profileId, req);
    if (!profile) return res.status(404).json({ error: 'Collateral profile not found' });

    const updated = await collateral.approveProfile(profile.id, { actor: 'supplier', note: req.body.note });
    emitToTrader(profile.traderId, { type: 'collateral_updated', supplierId: profile.supplierId, reviewStatus: updated.reviewStatus });
    res.json({ data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve collateral' });
  }
});

// POST /api/collateral/:profileId/reject — supplier rejects the collateral's current state
router.post('/:profileId/reject', requireAuth, requireSupplier, async (req, res) => {
  try {
    const profile = await loadProfileForAuth(req.params.profileId, req);
    if (!profile) return res.status(404).json({ error: 'Collateral profile not found' });

    const updated = await collateral.rejectProfile(profile.id, { actor: 'supplier', note: req.body.note });
    emitToTrader(profile.traderId, { type: 'collateral_updated', supplierId: profile.supplierId, reviewStatus: updated.reviewStatus });
    res.json({ data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reject collateral' });
  }
});

// POST /api/collateral/:profileId/release — supplier manually releases held collateral
router.post('/:profileId/release', requireAuth, requireSupplier, async (req, res) => {
  try {
    const profile = await loadProfileForAuth(req.params.profileId, req);
    if (!profile) return res.status(404).json({ error: 'Collateral profile not found' });

    const updated = await collateral.releaseProfile(profile.id, { actor: 'supplier', note: req.body.note });
    emitToTrader(profile.traderId, { type: 'collateral_updated', supplierId: profile.supplierId, status: updated.status });
    res.json({ data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to release collateral' });
  }
});

// POST /api/collateral/:profileId/forfeit — supplier manually forfeits held collateral
router.post('/:profileId/forfeit', requireAuth, requireSupplier, async (req, res) => {
  try {
    const profile = await loadProfileForAuth(req.params.profileId, req);
    if (!profile) return res.status(404).json({ error: 'Collateral profile not found' });

    const updated = await collateral.forfeitProfile(profile.id, { actor: 'supplier', note: req.body.note });
    emitToTrader(profile.traderId, { type: 'collateral_updated', supplierId: profile.supplierId, status: updated.status });
    res.json({ data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to forfeit collateral' });
  }
});

module.exports = router;
