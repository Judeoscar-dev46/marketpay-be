const crypto = require('crypto');
const axios = require('axios');

const DEFAULT_PRODUCT_ID = 'f8b5bca1-b870-4648-8704-11c1802a51d0';
const DEFAULT_BASE_URL = 'https://v2.api.mycover.ai/v2';

function isStub() {
  return process.env.USE_STUB_MYCOVER === 'true' || !process.env.MYCOVER_SECRET_KEY;
}

function publicKey() {
  return process.env.MYCOVER_PUBLIC_KEY || '';
}

function creditLifeProductId() {
  return process.env.MYCOVER_CREDIT_LIFE_PRODUCT_ID || DEFAULT_PRODUCT_ID;
}

function baseUrl() {
  return (process.env.MYCOVER_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function rawBodyToString(rawBody) {
  if (rawBody == null) return '';
  if (Buffer.isBuffer(rawBody)) return rawBody.toString('utf8');
  if (typeof rawBody === 'string') return rawBody;
  try {
    return JSON.stringify(rawBody);
  } catch {
    return '';
  }
}

function hmacHex(payload) {
  return crypto.createHmac('sha512', process.env.MYCOVER_SECRET_KEY).update(payload).digest('hex');
}

function signaturesMatch(expectedHex, received) {
  if (!expectedHex || !received) return false;
  const a = Buffer.from(String(expectedHex), 'utf8');
  const b = Buffer.from(String(received).trim(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyWebhookSignature(rawBody, signature) {
  if (isStub()) return true;
  if (!process.env.MYCOVER_SECRET_KEY || !signature) return false;

  const raw = rawBodyToString(rawBody);
  if (signaturesMatch(hmacHex(raw), signature)) return true;

  try {
    const canonical = JSON.stringify(JSON.parse(raw));
    return signaturesMatch(hmacHex(canonical), signature);
  } catch {
    return false;
  }
}

function nairaToKobo(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function collectStrings(node, keys, out = []) {
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === 'object') collectStrings(value, keys, out);
    else if (keys.has(key) && value != null && String(value).trim()) out.push(String(value).trim());
  }
  return out;
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractPurchaseFields(event) {
  const data = event?.data || {};
  const essential = data.essential || {};
  const meta = data.meta || {};
  const sdk = data.sdk || {};
  const sdkConfig = sdk.config || {};

  const merchantRefs = uniqueNonEmpty([
    ...collectStrings(data, new Set(['reference', 'merchant_reference', 'merchantRef'])),
  ]);
  const policyIds = uniqueNonEmpty([
    essential.policy_id,
    data.policy_id,
    sdkConfig.policy_id,
    ...collectStrings(data, new Set(['policy_id'])),
  ]);

  const expiresRaw = essential.expiration_date || data.policy_expiry_date || data.expiration_date || meta.expiration_date;
  const expiresAt = expiresRaw ? new Date(expiresRaw) : null;

  return {
    eventId: event?.event_id || null,
    merchantRefs,
    policyId: policyIds[0] || null,
    policyNumber: essential.policy_number || meta.policy_number || data.policy_number || sdkConfig.policy_number || null,
    customerId: essential.customer_id || data.customer?.id || sdkConfig.customer_id || null,
    productId: essential.product_id || data.product_id || sdkConfig.pid || creditLifeProductId(),
    sumInsured: nairaToKobo(meta.sum_insured ?? data.sum_insured),
    premiumAmount: nairaToKobo(essential.amount ?? data.amount ?? meta.premium),
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    certificateUrl: sdk.certificate_url || meta.certificate_url || data.certificate_url || null,
    claimLink: sdk.claim_link || meta.claim_link || data.claim_link || null,
  };
}

function isCovering(policy, creditAmount) {
  if (!policy || policy.status !== 'active') return false;
  if (!Number.isInteger(creditAmount) || policy.sumInsured < creditAmount) return false;
  if (policy.expiresAt && new Date(policy.expiresAt) <= new Date()) return false;
  return true;
}

function toPublicPolicy(policy, creditAmount) {
  if (!policy) {
    return {
      status: null,
      covering: false,
      policyNumber: null,
      sumInsured: 0,
      expiresAt: null,
      claimLink: null,
      certificateUrl: null,
    };
  }
  return {
    status: policy.status,
    covering: isCovering(policy, creditAmount),
    policyNumber: policy.policyNumber,
    sumInsured: policy.sumInsured,
    premiumAmount: policy.premiumAmount,
    expiresAt: policy.expiresAt,
    claimLink: policy.claimLink,
    certificateUrl: policy.certificateUrl,
    stub: isStub(),
  };
}

async function authGet(path) {
  if (isStub()) return null;
  const res = await axios.get(`${baseUrl()}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.MYCOVER_SECRET_KEY}`,
      Accept: 'application/json',
    },
    timeout: 15000,
  });
  return res.data?.data ?? res.data;
}

async function getProduct(productId = creditLifeProductId()) {
  try {
    return await authGet(`/products/${productId}`);
  } catch (err) {
    console.error('MyCover getProduct failed:', err?.response?.data || err.message);
    return null;
  }
}

async function getPolicy(policyId) {
  if (!policyId) return null;
  try {
    return await authGet(`/policies/${policyId}`);
  } catch (err) {
    console.error('MyCover getPolicy failed:', err?.response?.data || err.message);
    return null;
  }
}

function newMerchantRef() {
  return `BUY-cl-${crypto.randomBytes(10).toString('hex')}`;
}

module.exports = {
  isStub,
  publicKey,
  creditLifeProductId,
  verifyWebhookSignature,
  extractPurchaseFields,
  isCovering,
  toPublicPolicy,
  getProduct,
  getPolicy,
  newMerchantRef,
};
