const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const termii = require('./termii');

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes, matches PRD §14
const MAX_ATTEMPTS = 5;

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtp(phone, purpose) {
  const code = generateCode();
  const codeHash = bcrypt.hashSync(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.otpCode.create({
    data: { phone, codeHash, purpose, expiresAt },
  });

  await termii.sendSms({
    to: phone,
    message: `Your MarketPay verification code is ${code}. It expires in 5 minutes.`,
  });
}

async function verifyOtp(phone, code, purpose) {
  const otp = await prisma.otpCode.findFirst({
    where: { phone, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) return { ok: false, error: 'No pending code for this phone number. Request a new one.' };
  if (otp.expiresAt < new Date()) return { ok: false, error: 'Code expired. Request a new one.' };
  if (otp.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'Too many attempts. Request a new code.' };

  const match = bcrypt.compareSync(code, otp.codeHash);
  if (!match) {
    await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, error: 'Incorrect code.' };
  }

  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date() } });
  return { ok: true };
}

module.exports = { sendOtp, verifyOtp };
