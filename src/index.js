require('dotenv').config();
const express = require('express');
const cors = require('cors');

const tradersRouter = require('./routes/traders');
const checkoutRouter = require('./routes/checkout');
const webhookRouter = require('./routes/webhook');
const simulateRouter = require('./routes/simulate');
const sseRouter = require('./routes/sse');
const ledgerRouter = require('./routes/ledger');

const app = express();

app.use(cors({ origin: '*' }));

app.use('/api/webhook', webhookRouter);

app.use(express.json());

app.get('/health', (_, res) => res.json({ ok: true }));

app.use('/api/traders', tradersRouter);
app.use('/api/checkout', checkoutRouter);
app.use('/api/simulate', simulateRouter);
app.use('/api/sse', sseRouter);
app.use('/api/ledger', ledgerRouter);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MarketPay backend listening on port ${PORT}`));
