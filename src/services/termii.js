const axios = require('axios');

const BASE_URL = process.env.TERMII_BASE_URL || 'https://api.ng.termii.com/api';
const USE_STUB = process.env.USE_STUB_OTP === 'true' || !process.env.TERMII_API_KEY;

/**
 * Termii requires a dialable international number (no leading 0, no '+').
 * Nigerian locals like 08165684582 → 2348165684582.
 */
function toDialablePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('234') && digits.length >= 13) return digits;
  if (digits.startsWith('0') && digits.length === 11) return `234${digits.slice(1)}`;
  if (digits.length === 10 && /^[789]/.test(digits)) return `234${digits}`;

  return digits;
}

async function sendSms({ to, message }) {
  const dialable = toDialablePhone(to);
  if (!dialable) {
    throw new Error('Recipient phone number is required');
  }

  if (USE_STUB) {
    console.log(`[STUB OTP SMS] to ${dialable}: ${message}`);
    return { stubbed: true };
  }

  const res = await axios.post(`${BASE_URL}/sms/send`, {
    api_key: process.env.TERMII_API_KEY,
    to: dialable,
    from: process.env.TERMII_SENDER_ID || 'MarketPay',
    sms: message,
    type: 'plain',
    channel: 'generic',
  });
  return res.data;
}

module.exports = { sendSms, toDialablePhone };
