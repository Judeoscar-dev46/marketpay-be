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
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    accountId: process.env.NOMBA_ACCOUNT_ID,
  };
}

async function createVirtualAccount({ name, reference }) {
  const token = await getAccessToken();
  const safeReference = reference.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
  const res = await axios.post(
    `${BASE_URL}/accounts/virtual`,
    {
      accountName: name,
      accountRef: safeReference,
    },
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
    throw new Error(`Nomba checkout failed: ${res.data.code} — ${res.data.description}`);
  }

  const d = res.data.data;
  return {
    checkoutUrl: d.checkoutLink,
    checkoutRef: d.orderReference || reference,
  };
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

async function payToBank({ fromAccountId, accountNumber, bankCode, amount, reference, narration }) {
  if (isStub()) {
    return { transferRef: `stub-payout-${reference}` };
  }
  const token = await getAccessToken();
  const res = await axios.post(
    `${BASE_URL}/transfers/bank`,
    {
      sourceAccountId: fromAccountId,
      destinationAccountNumber: accountNumber,
      destinationBankCode: bankCode,
      amount,
      currency: 'NGN',
      reference,
      narration: narration || `MarketPay supplier payout ${reference}`,
    },
    { headers: authHeaders(token) }
  );
  return { transferRef: res.data.data?.transferReference || reference };
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

// Resolves a bank account number to its registered account name, so a trader can confirm
// they're adding the right supplier before the record (and future money) is saved.
async function resolveAccountName({ accountNumber, bankCode }) {
  if (isStub()) {
    return { accountName: 'Verified Test Supplier Ltd', verified: false };
  }
  try {
    const token = await getAccessToken();
    const res = await axios.post(
      `${BASE_URL}/accounts/resolve`,
      { accountNumber, bankCode },
      { headers: authHeaders(token) }
    );
    if (res.data.code !== '00') throw new Error(res.data.description || 'resolve failed');
    return { accountName: res.data.data?.accountName, verified: true };
  } catch (err) {
    // Degrade gracefully — Nomba may not expose this endpoint. The trader-entered name
    // is used instead, just flagged as unverified rather than blocking supplier creation.
    console.warn('Nomba resolveAccountName unavailable, falling back to unverified:', err.message);
    return { accountName: null, verified: false };
  }
}

module.exports = {
  createVirtualAccount,
  createCheckout,
  initiateTransfer,
  payToBank,
  verifyWebhookSignature,
  resolveAccountName,
};
