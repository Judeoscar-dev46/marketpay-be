const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

router.get('/traders/:traderId', async (req, res) => {
  try {
    const trader = await prisma.trader.findUnique({
      where: { id: req.params.traderId },
      select: { id: true, name: true, business: true, market: true, mainAccountNumber: true },
    });
    if (!trader) return res.status(404).json({ error: 'Trader not found' });
    res.json({ data: trader });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trader' });
  }
});

module.exports = router;
