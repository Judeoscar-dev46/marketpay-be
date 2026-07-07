const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const nomba = require('../services/nomba');

const USE_STUB = process.env.USE_STUB_ACCOUNTS === 'true' || !process.env.NOMBA_CLIENT_ID;

const router = express.Router();

const TRADER_SELECT = {
  id: true,
  name: true,
  business: true,
  market: true,
  avatar: true,
  phone: true,
  mainVirtualAccountId: true,
  mainAccountNumber: true,
  supplierAccountId: true,
  supplierAccountNumber: true,
  savingsAccountId: true,
  savingsAccountNumber: true,
};

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, business, market, phone, avatar, pin } = req.body;

  if (!name?.trim() || !business?.trim() || !market?.trim()) {
    return res.status(400).json({ error: 'name, business, and market are required' });
  }
  if (!phone?.trim()) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  if (!pin || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
  }

  try {
    const existing = await prisma.trader.findUnique({ where: { phone: phone.trim() } });
    if (existing) {
      return res.status(409).json({ error: 'A trader with this phone number already exists' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Registration failed. Try again.' });
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
    const [main, supplier, savings] = await Promise.all([
      makeAccount('Main Till'),
      makeAccount('Supplier'),
      makeAccount('Savings'),
    ]);

    const pinHash = bcrypt.hashSync(pin, 10);

    const trader = await prisma.trader.create({
      data: {
        name: name.trim(),
        business: business.trim(),
        market: market.trim(),
        phone: phone.trim(),
        avatar: avatar || null,
        pinHash,
        mainVirtualAccountId: main.accountId,
        mainAccountNumber: main.accountNumber,
        supplierAccountId: supplier.accountId,
        supplierAccountNumber: supplier.accountNumber,
        savingsAccountId: savings.accountId,
        savingsAccountNumber: savings.accountNumber,
      },
      select: TRADER_SELECT,
    });

    res.status(201).json({ data: trader });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed. Try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { phone, pin } = req.body;

  if (!phone?.trim() || !pin) {
    return res.status(400).json({ error: 'Phone and PIN are required' });
  }

  try {
    const trader = await prisma.trader.findUnique({
      where: { phone: phone.trim() },
      select: { ...TRADER_SELECT, pinHash: true },
    });

    if (!trader || !trader.pinHash || !bcrypt.compareSync(pin, trader.pinHash)) {
      return res.status(401).json({ error: 'Incorrect phone number or PIN' });
    }

    const { pinHash: _, ...traderData } = trader;
    res.json({ data: traderData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed. Try again.' });
  }
});

module.exports = router;
