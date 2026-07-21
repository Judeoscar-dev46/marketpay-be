const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const nomba = require('../services/nomba');
const otp = require('../services/otp');
const { issueSession } = require('../middleware/auth');
const supplierInvites = require('../services/supplierInvites');

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
  tillPct: true,
  supplierPct: true,
  savingsPct: true,
};

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, business, market, phone, avatar, pin, inviteCode } = req.body;

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

    const token = issueSession({ id: trader.id, role: 'trader' });

    let inviteRedemption;
    if (inviteCode?.trim()) {
      try {
        await supplierInvites.redeemInvite({ traderId: trader.id, rawCode: inviteCode });
        inviteRedemption = { status: 'redeemed' };
      } catch (err) {
        console.warn('Register-time invite redemption skipped:', err.message);
        inviteRedemption = { status: 'invalid' };
      }
    }

    res.status(201).json({ data: trader, token, inviteRedemption });
  } catch (err) {
    console.error('Registration error:', err?.response?.data || err.message || err);
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
    const token = issueSession({ id: traderData.id, role: 'trader' });
    res.json({ data: traderData, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed. Try again.' });
  }
});

// POST /api/auth/otp/send — { phone, role: 'trader' | 'supplier' }
router.post('/otp/send', async (req, res) => {
  const { phone, role } = req.body;
  if (!phone?.trim() || !['trader', 'supplier'].includes(role)) {
    return res.status(400).json({ error: 'phone and a valid role are required' });
  }
  try {
    await otp.sendOtp(phone.trim(), `${role}_login`);
    res.json({ data: { sent: true } });
  } catch (err) {
    console.error('OTP send error:', err?.response?.data || err.message || err);
    res.status(500).json({ error: 'Failed to send verification code. Try again.' });
  }
});

// POST /api/auth/otp/verify — { phone, code, role: 'trader' | 'supplier' }
// Supplier: finds-or-creates a SupplierUser by phone — no shop setup needed on this path.
// Trader: OTP is an alternate login for an existing PIN-registered trader, not a replacement.
router.post('/otp/verify', async (req, res) => {
  const { phone, code, role } = req.body;
  if (!phone?.trim() || !code?.trim() || !['trader', 'supplier'].includes(role)) {
    return res.status(400).json({ error: 'phone, code, and a valid role are required' });
  }

  const result = await otp.verifyOtp(phone.trim(), code.trim(), `${role}_login`);
  if (!result.ok) return res.status(401).json({ error: result.error });

  try {
    if (role === 'supplier') {
      const supplierUser = await prisma.supplierUser.upsert({
        where: { phone: phone.trim() },
        create: { phone: phone.trim() },
        update: {},
      });
      // Retroactively link any Supplier rows a trader already entered under this phone number —
      // traders typically add a supplier long before that supplier ever signs into the app.
      await prisma.supplier.updateMany({
        where: { phone: phone.trim(), supplierUserId: null },
        data: { supplierUserId: supplierUser.id },
      });
      const token = issueSession({ id: supplierUser.id, role: 'supplier' });
      return res.json({ data: supplierUser, token });
    }

    const trader = await prisma.trader.findUnique({ where: { phone: phone.trim() }, select: TRADER_SELECT });
    if (!trader) return res.status(404).json({ error: 'No trader account found for this phone number' });
    const token = issueSession({ id: trader.id, role: 'trader' });
    return res.json({ data: trader, token });
  } catch (err) {
    console.error('OTP verify error:', err);
    res.status(500).json({ error: 'Verification failed. Try again.' });
  }
});

module.exports = router;
