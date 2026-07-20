const axios = require('axios');

const BASE_URL = process.env.TERMII_BASE_URL || 'https://api.ng.termii.com/api';
const USE_STUB = process.env.USE_STUB_OTP === 'true' || !process.env.TERMII_API_KEY;

async function sendSms({ to, message }) {
  if (USE_STUB) {
    console.log(`[STUB OTP SMS] to ${to}: ${message}`);
    return { stubbed: true };
  }

  const res = await axios.post(`${BASE_URL}/sms/send`, {
    api_key: process.env.TERMII_API_KEY,
    to,
    from: process.env.TERMII_SENDER_ID || 'MarketPay',
    sms: message,
    type: 'plain',
    channel: 'generic',
  });
  return res.data;
}

module.exports = { sendSms };
