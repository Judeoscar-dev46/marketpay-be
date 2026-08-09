const express = require('express');
const prisma = require('../lib/prisma');
const { requireAuth, requireTrader } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requireTrader);
router.use('/:traderId', (req, res, next) => {
  if (req.auth.id !== req.params.traderId) return res.status(403).json({ error: 'Not authorized for this trader account' });
  next();
});

// GET /api/ledger/:traderId/today
router.get('/:traderId/today', async (req, res) => {
  const { traderId } = req.params;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  try {
    const ledger = await prisma.dailyLedger.findUnique({
      where: { traderId_date: { traderId, date: today } },
    });

    const transactions = await prisma.transaction.findMany({
      where: {
        traderId,
        status: 'confirmed',
        createdAt: { gte: today },
      },
      include: { splitTransfers: true },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      data: {
        ledger: ledger || {
          totalSales: 0,
          totalSupplier: 0,
          totalSavings: 0,
          totalTillBalance: 0,
          txCount: 0,
        },
        transactions,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch today ledger' });
  }
});

// GET /api/ledger/:traderId/history?range=7|30|all
router.get('/:traderId/history', async (req, res) => {
  const { traderId } = req.params;
  const rawRange = String(req.query.range || '7');
  const range = ['7', '30', 'all'].includes(rawRange) ? rawRange : '7';

  try {
    const where = { traderId };

    if (range !== 'all') {
      const days = range === '30' ? 30 : 7;
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - (days - 1));
      where.date = { gte: from };
    }

    const history = await prisma.dailyLedger.findMany({
      where,
      orderBy: { date: 'desc' },
    });

    res.json({ data: history });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /api/ledger/:traderId/transactions — full list for a day
router.get('/:traderId/transactions', async (req, res) => {
  const { traderId } = req.params;
  const { date } = req.query;

  try {
    const from = date ? new Date(date) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    from.setHours(0, 0, 0, 0);
    const to = date ? new Date(date) : new Date();
    to.setHours(23, 59, 59, 999);

    const transactions = await prisma.transaction.findMany({
      where: {
        traderId,
        createdAt: { gte: from, lte: to },
      },
      include: { splitTransfers: true },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ data: transactions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

module.exports = router;
