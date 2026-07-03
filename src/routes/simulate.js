const express = require('express');
const prisma = require('../lib/prisma');
const { processPayment } = require('../services/split');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

router.post('/:transactionId', async (req, res) => {
  const { transactionId } = req.params;

  try {
    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } });

    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
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
