const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const traders = await prisma.trader.findMany({
      select: {
        id: true,
        name: true,
        business: true,
        market: true,
        avatar: true,
        mainAccountNumber: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ data: traders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch traders' });
  }
});

module.exports = router;
