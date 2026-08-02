const express = require('express');
const prisma = require('../lib/prisma');
const { processPayment } = require('../services/split');
const collateral = require('../services/collateral');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireTrader } = require('../middleware/auth');

const router = express.Router();

// POST /api/simulate/collateral-deposit — { supplierId, amount (kobo) } — trader-triggered demo
// tool that simulates cash landing in their collateral virtual account, without a real Nomba
// transfer. Reuses the same collateral.recordCashReceived path the real webhook calls.
// Must be registered before the generic '/:transactionId' route below, otherwise that wildcard
// route intercepts this literal path (Express matches routes in registration order).
router.post('/collateral-deposit', requireAuth, requireTrader, async (req, res) => {
  const { supplierId, amount } = req.body;
  if (!supplierId || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'supplierId and a positive integer amount (kobo) are required' });
  }

  try {
    const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier || supplier.traderId !== req.auth.id) return res.status(404).json({ error: 'Supplier not found' });

    const updated = await collateral.recordCashReceived({
      traderId: req.auth.id,
      amount,
      webhookRef: `sim-${uuidv4()}`,
    });
    res.json({ data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Simulation failed' });
  }
});

router.post('/:transactionId', requireAuth, requireTrader, async (req, res) => {
  const { transactionId } = req.params;

  try {
    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } });

    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.traderId !== req.auth.id) return res.status(403).json({ error: 'Not authorized for this transaction' });
    if (tx.status !== 'pending') {
      return res.status(400).json({ error: `Transaction already ${tx.status}` });
    }

    // Mark confirmed with a synthetic webhook reference
    await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: 'confirmed',
        webhookRef: `sim-${uuidv4()}`,
      },
    });

    // Fire splits (same path as real webhook)
    processPayment(transactionId).catch((err) =>
      console.error('Simulate split failed for tx', transactionId, err)
    );

    res.json({ ok: true, transactionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Simulation failed' });
  }
});

module.exports = router;
