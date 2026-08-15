const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = process.env.NOMBA_BASE_URL || 'https://api.nomba.com/v1';
let _accessToken = null;
let _tokenExpiry = 0;

function isStub() {
  return process.env.USE_STUB_ACCOUNTS === 'true' || !process.env.NOMBA_CLIENT_ID;
}

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;

  try {
    const res = await axios.post(
      `${BASE_URL}/auth/token/issue`,
      {
        grant_type: 'client_credentials',
        client_id: process.env.NOMBA_CLIENT_ID,
        client_secret: process.env.NOMBA_CLIENT_SECRET,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          accountId: process.env.NOMBA_ACCOUNT_ID,
        },
      }
    );

    _accessToken = res.data.data.access_token;
    _tokenExpiry = Date.now() + (res.data.data.expires_in - 60) * 1000;
    return _accessToken;
  } catch (err) {
    console.error('Nomba auth token error:', err?.response?.data || err?.message || err);
    const detail = err?.response?.data?.description || err?.response?.data?.message || err?.message || 'auth failed';
    throw new Error(`Nomba checkout failed: token issue — ${detail}`);
  }
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    accountId: process.env.NOMBA_ACCOUNT_ID,
  };
}

async function createVirtualAccount({ name, reference, bvn }) {
  const token = await getAccessToken();
  const safeReference = reference.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
  const body = {
    accountName: name,
    accountRef: safeReference,
  };
  if (bvn) body.bvn = bvn;
  const res = await axios.post(
    `${BASE_URL}/accounts/virtual`,
    body,
    { headers: authHeaders(token) }
  );
  if (res.data.code !== '00') {
    console.error('Nomba createVirtualAccount error response:', JSON.stringify(res.data));
    throw new Error(`Nomba createVirtualAccount failed: ${res.data.code} — ${res.data.description}`);
  }
  const d = res.data.data;
  return {
    accountId: d.accountRef,
    accountNumber: d.bankAccountNumber,
  };
}

async function createCheckout({ amount, reference, callbackUrl }) {
  if (isStub()) {
    return { checkoutUrl: `https://checkout.stub.marketpay.app/${reference}`, checkoutRef: reference };
  }
  try {
    const token = await getAccessToken();
    const amountNaira = (amount / 100).toFixed(2);

    const res = await axios.post(
      `${BASE_URL}/checkout/order`,
      {
        order: {
          orderReference: reference,
          amount: amountNaira,
          currency: 'NGN',
          callbackUrl: callbackUrl || process.env.NOMBA_CALLBACK_URL || 'https://example.com',
          customerEmail: 'customer@marketpay.app',
        },
      },
      { headers: authHeaders(token) }
    );

    if (res.data.code !== '00') {
      console.error('Nomba checkout error response:', JSON.stringify(res.data));
      throw new Error(`Nomba checkout failed: ${res.data.code} — ${res.data.description}`);
    }

    const d = res.data.data;
    return {
      checkoutUrl: d.checkoutLink,
      checkoutRef: d.orderReference || reference,
    };
  } catch (err) {
    if (err?.message?.startsWith('Nomba checkout failed:')) throw err;
    console.error('Nomba checkout request error:', err?.response?.data || err?.message || err);
    const detail = err?.response?.data?.description || err?.response?.data?.message || err?.message || 'unknown error';
    throw new Error(`Nomba checkout failed: ${detail}`);
  }
}

async function initiateTransfer({ from, to, amount, reference }) {
  if (isStub() || from?.startsWith('stub-') || to?.startsWith('stub-')) {
    return { transferRef: `stub-transfer-${reference}` };
  }
  const token = await getAccessToken();
  const res = await axios.post(
    `${BASE_URL}/transfers`,
    {
      sourceAccountId: from,
      destinationAccountId: to,
      amount,
      currency: 'NGN',
      reference,
      narration: `MarketPay auto-split ${reference}`,
    },
    { headers: authHeaders(token) }
  );
  const d = res.data.data;
  return {
    transferRef: d.transferReference || d.reference || reference,
  };
}

async function payToBank({
  fromAccountId,
  accountNumber,
  accountName,
  bankCode,
  amount,
  reference,
  narration,
  senderName,
}) {
  if (isStub()) {
    return { transferRef: `stub-payout-${reference}` };
  }
  if (!accountNumber || !bankCode || !accountName || !reference) {
    throw new Error('accountNumber, accountName, bankCode, and reference are required for bank transfer');
  }

  const token = await getAccessToken();
  const amountNaira = Number((amount / 100).toFixed(2));
  const body = {
    amount: amountNaira,
    accountNumber,
    accountName,
    bankCode,
    merchantTxRef: reference,
    senderName: senderName || 'MarketPay',
    narration: narration || `MarketPay supplier payout ${reference}`,
  };
  // Debit a specific virtual/sub-account when Nomba has profiled us for it.
  if (fromAccountId && fromAccountId !== process.env.NOMBA_ACCOUNT_ID) {
    body.sourceAccountId = fromAccountId;
  }

  try {
    const res = await axios.post(`${BASE_URL}/transfers/bank`, body, { headers: authHeaders(token) });
    if (res.data.code && res.data.code !== '00') {
      console.error('Nomba payToBank error response:', JSON.stringify(res.data));
      throw new Error(res.data.description || `Nomba bank transfer failed: ${res.data.code}`);
    }
    const d = res.data.data || {};
    return { transferRef: d.id || d.transferReference || d.meta?.merchantTxRef || reference };
  } catch (err) {
    if (err?.message?.startsWith('Nomba bank transfer failed')) throw err;
    console.error('Nomba payToBank request error:', err?.response?.data || err?.message || err);
    const errors = err?.response?.data?.errors;
    const detail = Array.isArray(errors)
      ? errors.join(', ')
      : (err?.response?.data?.description || err?.message || 'bank transfer failed');
    throw new Error(`Nomba bank transfer failed: ${detail}`);
  }
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.NOMBA_WEBHOOK_SECRET;
  if (!secret) {
    // Fail closed outside dev/stub mode — an unsigned webhook must never be trusted in production.
    return isStub() || process.env.NODE_ENV !== 'production';
  }
  if (!signatureHeader) return false;

  try {
    const computed = crypto
      .createHmac('sha512', secret)
      .update(rawBody)
      .digest('hex');

    const computedBuf = Buffer.from(computed, 'hex');
    const givenBuf = Buffer.from(signatureHeader, 'hex');
    if (computedBuf.length !== givenBuf.length) return false;

    return crypto.timingSafeEqual(computedBuf, givenBuf);
  } catch {
    return false;
  }
}

// Resolves a bank account number to its registered account name via Nomba
// POST /v1/transfers/bank/lookup. Returns { accountName, verified: true } only when
// Nomba returns a non-empty account name. Throws on stub-off lookup failures.
async function resolveAccountName({ accountNumber, bankCode }) {
  if (isStub()) {
    return { accountName: 'Verified Test Supplier Ltd', verified: true };
  }

  try {
    const token = await getAccessToken();
    const res = await axios.post(
      `${BASE_URL}/transfers/bank/lookup`,
      { accountNumber, bankCode },
      { headers: authHeaders(token) }
    );

    if (res.data.code !== '00') {
      console.warn('Nomba bank lookup rejected:', JSON.stringify(res.data));
      throw new Error(res.data.description || 'Bank account lookup failed');
    }

    const data = res.data.data || {};
    const accountName = (data.accountName || data.account_name || data.name || '').trim();
    if (!accountName) {
      console.warn('Nomba bank lookup missing accountName:', JSON.stringify(res.data));
      throw new Error('Bank returned no account name for this number');
    }

    return { accountName, verified: true };
  } catch (err) {
    if (err?.message && !err.response) {
      // Already a clear Error from above, or network error without Axios body
      console.warn('Nomba resolveAccountName failed:', err.message);
      throw err;
    }
    console.warn('Nomba resolveAccountName failed:', err?.response?.data || err.message || err);
    const detail =
      err?.response?.data?.description ||
      err?.response?.data?.message ||
      err?.message ||
      'Bank account lookup failed';
    throw new Error(detail);
  }
}

const STUB_BANKS = [
  { code: '058', name: 'GTBank' },
  { code: '044', name: 'Access Bank' },
  { code: '011', name: 'First Bank' },
  { code: '057', name: 'Zenith Bank' },
  { code: '033', name: 'UBA' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '221', name: 'Stanbic IBTC' },
  { code: '032', name: 'Union Bank' },
];

let _banksCache = null;
let _banksCacheAt = 0;
const BANKS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — Nomba's own docs say bank codes rarely change

// Fetches the full list of banks (commercial + microfinance) for bank-picker UIs.
async function getBanks() {
  if (isStub()) return STUB_BANKS;
  if (_banksCache && Date.now() - _banksCacheAt < BANKS_CACHE_TTL) return _banksCache;

  const token = await getAccessToken();
  const res = await axios.get(`${BASE_URL}/transfers/banks`, { headers: authHeaders(token) });
  if (res.data.code !== '00') {
    throw new Error(`Nomba getBanks failed: ${res.data.code} — ${res.data.description}`);
  }
  const raw = res.data.data?.results || res.data.data || [];
  // Normalize Nomba bank objects so BankPicker always gets { code, name }.
  // Nomba sometimes returns the same bankCode more than once — dedupe so React keys stay unique.
  const seen = new Set();
  _banksCache = (Array.isArray(raw) ? raw : [])
    .map((b) => ({
      code: String(b.code || b.bankCode || ''),
      name: b.name || b.bankName || String(b.code || b.bankCode || ''),
    }))
    .filter((b) => {
      if (!b.code || seen.has(b.code)) return false;
      seen.add(b.code);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  _banksCacheAt = Date.now();
  return _banksCache;
}

module.exports = {
  createVirtualAccount,
  createCheckout,
  initiateTransfer,
  payToBank,
  verifyWebhookSignature,
  resolveAccountName,
  getBanks,
};
