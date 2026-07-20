const express = require('express');
const prisma = require('../lib/prisma');
const { requireAuth, requireSupplier } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireSupplier);

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
