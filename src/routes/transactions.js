const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

// GET /api/transactions/:id
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const tx = await prisma.transaction.findUnique({
      where: { id },
      include: { splitTransfers: true },
    });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ data: tx });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch transaction' });
  }
});

module.exports = router;
