const express = require('express');
const {
  registerSseClient, removeSseClient,
  registerSupplierSseClient, removeSupplierSseClient,
} = require('../services/split');

const router = express.Router();

function openStream(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 25000);

  return ping;
}

router.get('/supplier/:supplierUserId', (req, res) => {
  const { supplierUserId } = req.params;
  const ping = openStream(res);
  registerSupplierSseClient(supplierUserId, res);
  req.on('close', () => {
    clearInterval(ping);
    removeSupplierSseClient(supplierUserId, res);
  });
});

router.get('/:traderId', (req, res) => {
  const { traderId } = req.params;
  const ping = openStream(res);
  registerSseClient(traderId, res);
  req.on('close', () => {
    clearInterval(ping);
    removeSseClient(traderId, res);
  });
});

module.exports = router;
