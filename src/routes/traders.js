const express = require('express');
const prisma = require('../lib/prisma');
const nomba = require('../services/nomba');
const { requireAuth, requireTrader } = require('../middleware/auth');
const { assertKycComplete } = require('../lib/kyc');

const USE_STUB = process.env.USE_STUB_ACCOUNTS === 'true' || !process.env.NOMBA_CLIENT_ID;

const router = express.Router();

router.use(requireAuth, requireTrader);

function requireOwnTrader(req, res, next) {
  if (req.auth.id !== req.params.traderId) return res.status(403).json({ error: 'Not authorized for this trader account' });
  next();
}

// GET /api/traders — list all traders
router.get('/', async (req, res) => {
  try {
    const traders = await prisma.trader.findMany({
      select: {
        id: true,
        name: true,
        business: true,
        market: true,
        avatar: true,
        mainAccountNumber: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ data: traders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch traders' });
  }
});

// POST /api/traders — register a new trader (creates 3 Nomba virtual accounts)
router.post('/', async (req, res) => {
  const { name, business, market, phone, avatar } = req.body;
  if (!name?.trim() || !business?.trim() || !market?.trim()) {
    return res.status(400).json({ error: 'name, business, and market are required' });
  }

  const slug = name.toLowerCase().replace(/\s+/g, '-');
  const ref = `${slug}-${Date.now()}`;

  async function makeAccount(label) {
    if (USE_STUB) {
      return {
        accountId: `stub-${ref}-${label}`,
        accountNumber: `00${Math.floor(10000000 + Math.random() * 90000000)}`,
      };
    }
    return nomba.createVirtualAccount({ name: `${name} ${label}`, reference: `${ref}-${label}` });
  }

  try {
    const [main, supplier, savings, collateral] = await Promise.all([
      makeAccount('Main Till'),
      makeAccount('Supplier'),
      makeAccount('Savings'),
      makeAccount('Collateral'),
    ]);

    const trader = await prisma.trader.create({
      data: {
        name: name.trim(),
        business: business.trim(),
        market: market.trim(),
        phone: phone?.trim() || null,
        avatar: avatar || null,
        mainVirtualAccountId: main.accountId,
        mainAccountNumber: main.accountNumber,
        supplierAccountId: supplier.accountId,
        supplierAccountNumber: supplier.accountNumber,
        savingsAccountId: savings.accountId,
        savingsAccountNumber: savings.accountNumber,
        collateralAccountId: collateral.accountId,
        collateralAccountNumber: collateral.accountNumber,
      },
    });

    res.status(201).json({ data: trader });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create trader. Try again.' });
  }
});

// GET /api/traders/:traderId/supplier-balance — total supplier fund accumulated
router.get('/:traderId/supplier-balance', requireOwnTrader, async (req, res) => {
  const { traderId } = req.params;
  try {
    const { _sum } = await prisma.transaction.aggregate({
      where: { traderId, status: 'confirmed' },
      _sum: { supplierAmount: true },
    });
    res.json({ data: { balance: _sum.supplierAmount || 0 } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch supplier balance' });
  }
});

// POST /api/traders/:traderId/pay-supplier — initiate bank transfer from supplier fund
router.post('/:traderId/pay-supplier', requireOwnTrader, async (req, res) => {
  const { traderId } = req.params;
  const { accountNumber, bankCode, bankName, amount } = req.body;
  if (!accountNumber || !bankCode || !amount || amount <= 0) {
    return res.status(400).json({ error: 'accountNumber, bankCode, and amount are required' });
  }

  try {
    const trader = await prisma.trader.findUnique({
      where: { id: traderId },
      select: { id: true, name: true, supplierAccountId: true },
    });
    if (!trader) return res.status(404).json({ error: 'Trader not found' });

    const matchedSupplier = await prisma.supplier.findFirst({
      where: { traderId, accountNumber, bankCode, archivedAt: null },
      select: { resolvedAccountName: true, name: true },
    });
    const accountName = matchedSupplier?.resolvedAccountName || matchedSupplier?.name || bankName;
    if (!accountName) {
      return res.status(400).json({ error: 'Could not resolve the destination account name' });
    }

    const ref = `payout-${traderId}-${Date.now()}`;
    const result = await nomba.payToBank({
      fromAccountId: trader.supplierAccountId,
      accountNumber,
      accountName,
      bankCode,
      amount,
      reference: ref,
      senderName: trader.name,
      narration: `Supplier payment to ${bankName || accountName}`,
    });

    res.json({ data: { transferRef: result.transferRef, amount } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Payout failed. Check account details and try again.' });
  }
});

// POST /api/traders/:traderId/withdraw — { source: 'main' | 'savings', amount } to the trader's own bank account
router.post('/:traderId/withdraw', requireOwnTrader, async (req, res) => {
  const { traderId } = req.params;
  const { source, amount } = req.body;
  if (!['main', 'savings'].includes(source) || !amount || amount <= 0) {
    return res.status(400).json({ error: 'source (main|savings) and amount are required' });
  }

  try {
    const trader = await prisma.trader.findUnique({ where: { id: traderId } });
    if (!trader) return res.status(404).json({ error: 'Trader not found' });
    try {
      assertKycComplete(trader, 'Complete KYC and add your market details before withdrawing');
    } catch (err) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }

    const fromAccountId = source === 'savings' ? trader.savingsAccountId : trader.mainVirtualAccountId;
    const ref = `withdraw-${traderId}-${Date.now()}`;
    const result = await nomba.payToBank({
      fromAccountId,
      accountNumber: trader.accountNumber,
      accountName: trader.resolvedAccountName || trader.name,
      bankCode: trader.bankCode,
      amount,
      reference: ref,
      senderName: trader.name,
      narration: `MarketPay withdrawal — ${trader.name}`,
    });

    res.json({ data: { transferRef: result.transferRef, amount, source } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Withdrawal failed. Check your bank details and try again.' });
  }
});

// PATCH /api/traders/:traderId/split — update split percentages
router.patch('/:traderId/split', requireOwnTrader, async (req, res) => {
  const { traderId } = req.params;
  const { tillPct, supplierPct, savingsPct } = req.body;

  const pcts = [tillPct, supplierPct, savingsPct];
  if (pcts.some((p) => !Number.isInteger(p) || p < 1)) {
    return res.status(400).json({ error: 'All percentages must be integers of at least 1' });
  }
  if (tillPct + supplierPct + savingsPct !== 100) {
    return res.status(400).json({ error: 'Percentages must sum to 100' });
  }

  try {
    const trader = await prisma.trader.update({
      where: { id: traderId },
      data: { tillPct, supplierPct, savingsPct },
      select: {
        id: true, name: true, business: true, market: true, avatar: true, phone: true,
        mainVirtualAccountId: true, mainAccountNumber: true,
        supplierAccountId: true, supplierAccountNumber: true,
        savingsAccountId: true, savingsAccountNumber: true,
        tillPct: true, supplierPct: true, savingsPct: true,
      },
    });
    res.json({ data: trader });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update split percentages' });
  }
});

module.exports = router;
