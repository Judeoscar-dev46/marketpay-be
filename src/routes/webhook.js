const express = require('express');
const prisma = require('../lib/prisma');
const nomba = require('../services/nomba');
const { processPayment } = require('../services/split');
const collateral = require('../services/collateral');

const router = express.Router();

function rawBodyToString(rawBody) {
  if (rawBody == null) return '';
  if (Buffer.isBuffer(rawBody)) return rawBody.toString('utf8');
  if (typeof rawBody === 'string') return rawBody;
  try {
    return JSON.stringify(rawBody);
  } catch {
    return '';
  }
}

function isWebhookProbe(rawBody, signature) {
  if (signature) return false;
  const body = rawBodyToString(rawBody).trim();
  return !body || body === '{}' || body === 'null' || body === '[]';
}

// GET /api/webhook/nomba
// - No query: URL verification / health check for Nomba dashboard (must return 200)
// - With orderReference: browser redirect after Nomba Checkout completes
router.get('/nomba', async (req, res) => {
  const { orderReference } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  if (!orderReference) {
    return res.status(200).json({ status: 'ok', service: 'marketpay-nomba-webhook' });
  }

  try {
    const tx = await prisma.transaction.findFirst({
      where: {
        OR: [{ id: orderReference }, { checkoutRef: orderReference }],
        status: 'pending',
      },
    });

    if (!tx) {
      console.log('Callback: no pending tx for orderReference', orderReference);
      return res.redirect(`${frontendUrl}/dashboard`);
    }

    await prisma.transaction.update({
      where: { id: tx.id },
      data: {
        status: 'confirmed',
        webhookRef: `callback-${orderReference}`,
      },
    });

    // Run splits synchronously before redirect
    await processPayment(tx.id).catch((err) =>
      console.error('Split processing failed for tx', tx.id, err)
    );

    return res.redirect(`${frontendUrl}/payment-done`);
  } catch (err) {
    console.error('Callback redirect error:', err);
    return res.redirect(`${frontendUrl}/dashboard`);
  }
});

// POST /api/webhook/nomba — server-to-server webhook from Nomba
// Must use express.raw() on this route — mounted in index.js before express.json()
router.post('/nomba', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBody = req.body;
  const signature = req.headers['x-nomba-signature'] || req.headers['nomba-signature'] || '';

  // Nomba dashboard validates webhook URLs with an unsigned empty/minimal POST.
  // Accept those probes with 200 without processing. Real events still require a valid signature.
  if (isWebhookProbe(rawBody, signature)) {
    return res.status(200).json({ status: 'ok' });
  }

  try {
    if (!nomba.verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBodyToString(rawBody) || '{}');
    const nombaRef = event?.data?.reference || event?.data?.transactionReference || event?.reference;
    const checkoutRef = event?.data?.orderReference || event?.data?.checkoutReference;

    // Idempotency: if we already processed this nomba reference, ack and stop
    if (nombaRef) {
      const exists = await prisma.transaction.findUnique({ where: { webhookRef: nombaRef } });
      if (exists) return res.json({ status: 'already_processed' });
    }

    // Direct virtual-account credit — a different event shape from the checkout-completion
    // flow above (there's no pre-existing Transaction row to match against). Used for cash
    // collateral deposits into a trader's collateral virtual account.
    // NOTE: the exact Nomba field names for this event type (event_type/type, and which field
    // carries the credited account id) are unconfirmed against real Nomba docs/sandbox — this
    // is a best-effort branch flagged for verification, not a tested integration.
    const eventType = event?.event_type || event?.type;
    const creditedAccountId = event?.data?.virtualAccountId || event?.data?.accountId || event?.data?.destinationAccountId;
    const creditedAmountKobo = Math.round((event?.data?.amount || 0) * 100) || event?.data?.amountKobo;

    if (eventType && /credit|deposit/i.test(eventType) && creditedAccountId) {
      const trader = await prisma.trader.findFirst({ where: { collateralAccountId: creditedAccountId } });
      if (trader && creditedAmountKobo > 0) {
        const dedupRef = nombaRef || `${creditedAccountId}-${creditedAmountKobo}-${event?.data?.createdAt || Date.now()}`;
        const already = await prisma.collateralEvent.findFirst({ where: { note: dedupRef, eventType: 'deposit' } });
        if (already) return res.json({ status: 'already_processed' });

        res.json({ status: 'ok' });
        collateral.recordCashReceived({ traderId: trader.id, amount: creditedAmountKobo, webhookRef: dedupRef }).catch((err) =>
          console.error('recordCashReceived failed for trader', trader.id, err)
        );
        return;
      }
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
