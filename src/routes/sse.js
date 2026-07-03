const express = require('express');
const { registerSseClient, removeSseClient } = require('../services/split');

const router = express.Router();

router.get('/:traderId', (req, res) => {
  const { traderId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send a heartbeat immediately so the client knows connection is live
  res.write('data: {"type":"connected"}\n\n');

  registerSseClient(traderId, res);

  // Keep-alive ping every 25s
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    removeSseClient(traderId, res);
  });
});

module.exports = router;
