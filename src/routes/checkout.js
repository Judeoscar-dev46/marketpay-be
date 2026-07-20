const express = require('express');
const prisma = require('../lib/prisma');
const nomba = require('../services/nomba');

const router = express.Router();

// Deliberately unauthenticated — this is the entry point for both the trader's own "Charge"
// flow and the public /c/:traderId customer payment link. A customer paying a trader never
// has (or needs) a MarketPay account, so this route can't require a session.
router.post('/', async (req, res) => {
  const { traderId, amount } = req.body;

  if (!traderId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'traderId and amount (in kobo) are required' });
  }

  try {
    const trader = await prisma.trader.findUnique({ where: { id: traderId } });
    if (!trader) return res.status(404).json({ error: 'Trader not found' });

    const tx = await prisma.transaction.create({
      data: { traderId, amount: parseInt(amount), status: 'pending' },
    });

    const { checkoutUrl, checkoutRef } = await nomba.createCheckout({
      amount,
      reference: tx.id,
    });

    const updated = await prisma.transaction.update({
      where: { id: tx.id },
      data: { checkoutUrl, checkoutRef },
    });

    res.json({
      data: {
        transactionId: updated.id,
        checkoutUrl,
        virtualAccountNumber: trader.mainAccountNumber,
        amount,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create checkout' });
  }
});

module.exports = router;
