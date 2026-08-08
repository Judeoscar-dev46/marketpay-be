const express = require('express');
const prisma = require('../lib/prisma');
const nomba = require('../services/nomba');

const router = express.Router();

function checkoutPayload(trader, tx) {
  return {
    transactionId: tx.id,
    checkoutUrl: tx.checkoutUrl,
    virtualAccountNumber: trader.mainAccountNumber,
    amount: tx.amount,
  };
}

async function ensureCheckout(trader, tx) {
  if (tx.checkoutUrl) return tx;

  const { checkoutUrl, checkoutRef } = await nomba.createCheckout({
    amount: tx.amount,
    reference: tx.id,
  });

  return prisma.transaction.update({
    where: { id: tx.id },
    data: { checkoutUrl, checkoutRef },
  });
}

function checkoutErrorMessage(err) {
  const msg = err?.message || String(err);
  if (/Nomba/i.test(msg)) {
    return 'Payment provider unavailable. Try again shortly.';
  }
  if (err?.code === 'P2022' || /clientRequestId|column .* does not exist/i.test(msg)) {
    return 'Checkout is temporarily unavailable (database schema). Please try again later.';
  }
  return 'Failed to create checkout';
}

// Deliberately unauthenticated — this is the entry point for both the trader's own "Charge"
// flow and the public /c/:traderId customer payment link. A customer paying a trader never
// has (or needs) a MarketPay account, so this route can't require a session.
router.post('/', async (req, res) => {
  const { traderId, amount, clientRequestId } = req.body;

  if (!traderId || !amount || amount <= 0) {
    return res.status(400).json({ error: 'traderId and amount (in kobo) are required' });
  }

  try {
    const trader = await prisma.trader.findUnique({ where: { id: traderId } });
    if (!trader) return res.status(404).json({ error: 'Trader not found' });

    const amountKobo = parseInt(amount, 10);

    if (clientRequestId) {
      const existing = await prisma.transaction.findUnique({
        where: { clientRequestId },
      });

      if (existing) {
        if (existing.traderId !== traderId) {
          return res.status(409).json({ error: 'clientRequestId belongs to another trader' });
        }
        const updated = await ensureCheckout(trader, existing);
        return res.json({ data: checkoutPayload(trader, updated) });
      }
    }

    const tx = await prisma.transaction.create({
      data: {
        traderId,
        amount: amountKobo,
        status: 'pending',
        ...(clientRequestId ? { clientRequestId } : {}),
      },
    });

    const updated = await ensureCheckout(trader, tx);

    res.json({ data: checkoutPayload(trader, updated) });
  } catch (err) {
    console.error('Checkout failed:', {
      message: err?.message,
      code: err?.code,
      meta: err?.meta,
      response: err?.response?.data,
      traderId: req.body?.traderId,
      amount: req.body?.amount,
      clientRequestId: req.body?.clientRequestId || null,
    });
    res.status(500).json({ error: checkoutErrorMessage(err) });
  }
});

module.exports = router;
