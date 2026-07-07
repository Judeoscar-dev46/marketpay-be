require('dotenv').config();
const express = require('express');
const cors = require('cors');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Set it in your environment or .env file.');
  process.exit(1);
}

const authRouter = require('./routes/auth');
const tradersRouter = require('./routes/traders');
const checkoutRouter = require('./routes/checkout');
const transactionsRouter = require('./routes/transactions');
const webhookRouter = require('./routes/webhook');
const simulateRouter = require('./routes/simulate');
const sseRouter = require('./routes/sse');
const ledgerRouter = require('./routes/ledger');
const publicRouter = require('./routes/public');

const app = express();

app.use(cors({ origin: '*' }));

app.use('/api/webhook', webhookRouter);

app.use(express.json());

app.get('/health', (_, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/traders', tradersRouter);
app.use('/api/checkout', checkoutRouter);
app.use('/api/simulate', simulateRouter);
app.use('/api/sse', sseRouter);
app.use('/api/ledger', ledgerRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/public', publicRouter);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MarketPay backend listening on port ${PORT}`));
