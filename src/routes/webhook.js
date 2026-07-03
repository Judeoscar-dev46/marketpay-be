const express = require('express');
const prisma = require('../lib/prisma');
const nomba = require('../services/nomba');
const { processPayment } = require('../services/split');

const router = express.Router();

// Must use express.raw() on this route — mounted in index.js before express.json()
router.post('/nomba', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBody = req.body;
  const signature = req.headers['x-nomba-signature'] || req.headers['nomba-signature'] || '';

  try {
    if (!nomba.verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString());
    const nombaRef = event?.data?.reference || event?.data?.transactionReference || event?.reference;
    const checkoutRef = event?.data?.orderReference || event?.data?.checkoutReference;

    // Idempotency: if we already processed this nomba reference, ack and stop
    if (nombaRef) {
      const exists = await prisma.transaction.findUnique({ where: { webhookRef: nombaRef } });
      if (exists) return res.json({ status: 'already_processed' });
    }

    // Find pending transaction by checkoutRef (our transaction id)
    const tx = await prisma.transaction.findFirst({
      where: {
        OR: [
          { checkoutRef },
          { id: checkoutRef },
        ],
        status: 'pending',
      },
    });

    if (!tx) {
      console.warn('Webhook: no matching pending transaction for ref', checkoutRef);
      return res.json({ status: 'no_match' });
    }

    // Mark confirmed immediately so idempotency guard works for race conditions
    await prisma.transaction.update({
      where: { id: tx.id },
      data: { status: 'confirmed', webhookRef: nombaRef || `nomba-${tx.id}-${Date.now()}` },
    });

    // Process splits asynchronously — respond to Nomba first
    res.json({ status: 'ok' });

    processPayment(tx.id).catch((err) =>
      console.error('Split processing failed for tx', tx.id, err)
    );
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
