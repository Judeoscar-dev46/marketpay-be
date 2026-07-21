const prisma = require('../lib/prisma');
const nomba = require('./nomba');
const { assertAllocationFits } = require('./supplierAllocation');

const USE_STUB = process.env.USE_STUB_ACCOUNTS === 'true' || !process.env.NOMBA_CLIENT_ID;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L — avoids mis-transcription
const CODE_LENGTH = 8;

class RedemptionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeCode(raw) {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function maskAccountNumber(accountNumber) {
  if (!accountNumber || accountNumber.length < 4) return '••••';
  return `•••• ${accountNumber.slice(-4)}`;
}

// Generates and persists an invite code only if one doesn't already exist — never regenerates.
async function ensureInviteCode(supplierUserId) {
  const supplierUser = await prisma.supplierUser.findUnique({ where: { id: supplierUserId } });
  if (!supplierUser) throw new RedemptionError(404, 'Supplier profile not found');
  if (supplierUser.inviteCode) return supplierUser;

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCode();
    const clash = await prisma.supplierUser.findUnique({ where: { inviteCode: candidate } });
    if (!clash) {
      return prisma.supplierUser.update({
        where: { id: supplierUserId },
        data: { inviteCode: candidate, inviteCodeCreatedAt: new Date() },
      });
    }
  }
  throw new RedemptionError(500, 'Could not generate a unique invite code — try again');
}

// Read-only lookup for a trader previewing a code before redeeming it — creates nothing.
async function previewInvite(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const supplierUser = await prisma.supplierUser.findUnique({ where: { inviteCode: code } });
  if (!supplierUser) return null;

  return {
    businessName: supplierUser.businessName || supplierUser.name || 'Supplier',
    bankName: supplierUser.bankName,
    maskedAccountNumber: maskAccountNumber(supplierUser.accountNumber),
    resolvedAccountName: supplierUser.resolvedAccountName,
    accountNameVerified: supplierUser.accountNameVerified,
    suggestedMode: supplierUser.suggestedMode || 'restock',
    suggestedAllocationPct: supplierUser.suggestedAllocationPct || 10,
    formattedCode: formatCode(code),
  };
}

async function makeSubAccount({ traderName, supplierName, ref }) {
  if (USE_STUB) {
    return {
      accountId: `stub-${ref}`,
      accountNumber: `00${Math.floor(10000000 + Math.random() * 90000000)}`,
    };
  }
  return nomba.createVirtualAccount({ name: `${traderName} — ${supplierName}`, reference: ref });
}

// Creates the actual Supplier relationship from a code — used by both the trader's own
// "redeem a code" screen and the optional inviteCode field on registration.
async function redeemInvite({ traderId, rawCode, allocationPct, mode, payoutSchedule }) {
  const code = normalizeCode(rawCode);
  if (!code) throw new RedemptionError(400, 'Invite code is required');

  const supplierUser = await prisma.supplierUser.findUnique({ where: { inviteCode: code } });
  if (!supplierUser) throw new RedemptionError(404, 'Invite code not found');
  if (!supplierUser.accountNumber || !supplierUser.bankCode) {
    throw new RedemptionError(400, 'This supplier has not finished setting up their profile yet');
  }

  const existingRelationship = await prisma.supplier.findFirst({
    where: { traderId, supplierUserId: supplierUser.id, archivedAt: null },
  });
  if (existingRelationship) throw new RedemptionError(409, 'You already have a relationship with this supplier');

  const trader = await prisma.trader.findUnique({ where: { id: traderId } });
  if (!trader) throw new RedemptionError(404, 'Trader not found');

  const resolvedMode = ['restock', 'credit_repayment'].includes(mode)
    ? mode
    : (supplierUser.suggestedMode || 'restock');
  const resolvedAllocationPct = Number.isInteger(allocationPct)
    ? allocationPct
    : (supplierUser.suggestedAllocationPct || 10);
  const resolvedSchedule = ['immediate', 'daily', 'weekly'].includes(payoutSchedule) ? payoutSchedule : 'immediate';

  if (resolvedAllocationPct < 1 || resolvedAllocationPct > 99) {
    throw new RedemptionError(400, 'allocationPct must be between 1 and 99');
  }

  try {
    await assertAllocationFits({ traderId, allocationPct: resolvedAllocationPct, trader });
  } catch (err) {
    throw new RedemptionError(err.status || 400, err.message);
  }

  let virtualAccountId = null;
  let virtualAccountNumber = null;
  if (resolvedSchedule !== 'immediate') {
    const va = await makeSubAccount({
      traderName: trader.name,
      supplierName: supplierUser.businessName || supplierUser.name || 'Supplier',
      ref: `${traderId}-supplier-invite-${Date.now()}`,
    });
    virtualAccountId = va.accountId;
    virtualAccountNumber = va.accountNumber;
  }

  const supplier = await prisma.supplier.create({
    data: {
      traderId,
      name: supplierUser.businessName || supplierUser.name || 'Supplier',
      phone: supplierUser.phone,
      bankCode: supplierUser.bankCode,
      bankName: supplierUser.bankName,
      accountNumber: supplierUser.accountNumber,
      resolvedAccountName: supplierUser.resolvedAccountName,
      accountNameVerified: supplierUser.accountNameVerified,
      mode: resolvedMode,
      allocationPct: resolvedAllocationPct,
      payoutSchedule: resolvedSchedule,
      relationshipStatus: 'accepted',
      onboardedVia: 'code_redeemed',
      virtualAccountId,
      virtualAccountNumber,
      supplierUserId: supplierUser.id,
    },
  });

  return { supplier, supplierUser };
}

module.exports = { RedemptionError, ensureInviteCode, previewInvite, redeemInvite, maskAccountNumber, normalizeCode };
