const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = process.env.NOMBA_BASE_URL || 'https://api.nomba.com/v1';
let _accessToken = null;
let _tokenExpiry = 0;

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
  const safeReference = reference.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '');
  const res = await axios.post(
    `${BASE_URL}/accounts/virtual`,
    {
      accountName: name,
      accountReference: safeReference,
      bvn: process.env.NOMBA_DEMO_BVN || '12345678901',
    },
    { headers: authHeaders(token) }
  );
  if (res.data.code !== '00') {
    throw new Error(`Nomba createVirtualAccount failed: ${res.data.code} — ${res.data.description}`);
  }
  const d = res.data.data;
  return {
    accountId: d.accountId,
    accountNumber: d.accountNumber,
  };
}

async function createCheckout({ amount, reference, callbackUrl }) {
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
  if (process.env.USE_STUB_ACCOUNTS === 'true' || !process.env.NOMBA_CLIENT_ID) {
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
  if (!secret) return true;

  const computed = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(computed, 'hex'),
    Buffer.from(signatureHeader, 'hex')
  );
}

module.exports = {
  createVirtualAccount,
  createCheckout,
  initiateTransfer,
  payToBank,
  verifyWebhookSignature,
};
