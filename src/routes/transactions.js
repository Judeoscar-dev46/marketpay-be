const express = require('express');
const prisma = require('../lib/prisma');
const { requireAuth, requireTrader } = require('../middleware/auth');

const router = express.Router();

// GET /api/transactions/:id
router.get('/:id', requireAuth, requireTrader, async (req, res) => {
  const { id } = req.params;
  try {
    const tx = await prisma.transaction.findUnique({
      where: { id },
      include: { splitTransfers: { include: { supplier: true } } },
    });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.traderId !== req.auth.id) return res.status(403).json({ error: 'Not authorized for this transaction' });
    res.json({ data: tx });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch transaction' });
  }
});

module.exports = router;
