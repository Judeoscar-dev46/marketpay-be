const prisma = require('../lib/prisma');
const nomba = require('./nomba');
const commitmentScore = require('./commitmentScore');

const USE_STUB = process.env.USE_STUB_ACCOUNTS === 'true' || !process.env.NOMBA_CLIENT_ID;

class CollateralError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Lazily creates the trader's 4th (collateral) Nomba virtual account the first time it's
// needed — avoids a backfill migration for traders that existed before this feature shipped.
async function ensureCollateralAccount(trader) {
  if (trader.collateralAccountId) return trader;

  const ref = `${trader.id}-collateral-${Date.now()}`;
  const account = USE_STUB
    ? { accountId: `stub-${ref}`, accountNumber: `00${Math.floor(10000000 + Math.random() * 90000000)}` }
    : await nomba.createVirtualAccount({ name: `${trader.name} Collateral`, reference: ref });

  return prisma.trader.update({
    where: { id: trader.id },
    data: { collateralAccountId: account.accountId, collateralAccountNumber: account.accountNumber },
  });
}

async function getOrCreateProfile({ traderId, supplierId, requestedAmount }) {
  if (!Number.isInteger(requestedAmount) || requestedAmount <= 0) {
    throw new CollateralError(400, 'requestedAmount (kobo) must be a positive integer');
  }

  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId }, include: { collateralProfile: true } });
  if (!supplier || supplier.traderId !== traderId) throw new CollateralError(404, 'Supplier not found');

  let trader = await prisma.trader.findUnique({ where: { id: traderId } });
  trader = await ensureCollateralAccount(trader);

  let profile = supplier.collateralProfile;
  if (!profile) {
    profile = await prisma.collateralProfile.create({
      data: { supplierId, traderId, requestedAmount },
    });
    await prisma.collateralEvent.create({
      data: { collateralProfileId: profile.id, eventType: 'created', amount: requestedAmount, actor: 'trader' },
    });
  }

  return { profile, collateralAccountNumber: trader.collateralAccountNumber };
}

// Corrects the goods-value denominator on a still-open profile (pending/active) — e.g. a
// mistyped amount. Recompute afterward naturally re-derives the ratio/score/ceiling against
// the corrected figure, even if cash has already been deposited against the old one.
async function updateRequestedAmount(collateralProfileId, requestedAmount, { actor = 'trader', note } = {}) {
  if (!Number.isInteger(requestedAmount) || requestedAmount <= 0) {
    throw new CollateralError(400, 'requestedAmount (kobo) must be a positive integer');
  }

  const profile = await prisma.collateralProfile.findUnique({ where: { id: collateralProfileId } });
  if (!profile) throw new CollateralError(404, 'Collateral profile not found');
  if (profile.status === 'released' || profile.status === 'forfeited') {
    throw new CollateralError(400, 'Cannot change the requested amount on a closed collateral profile');
  }

  await prisma.collateralProfile.update({
    where: { id: collateralProfileId },
    // Any prior supplier approval was of the OLD amount — invalidate it so they re-review.
    data: { requestedAmount, reviewStatus: 'pending', reviewedAt: null },
  });
  await prisma.collateralEvent.create({
    data: { collateralProfileId, eventType: 'corrected', amount: requestedAmount, note, actor },
  });

  return recompute(collateralProfileId, { actor, note: 'Recomputed after requested amount correction' });
}

async function recompute(collateralProfileId, { actor = 'system', note } = {}) {
  const profile = await prisma.collateralProfile.findUnique({ where: { id: collateralProfileId } });
  if (!profile) throw new CollateralError(404, 'Collateral profile not found');

  // Released/forfeited collateral no longer backs anything — zero the score rather than
  // leaving a stale eligible/commitmentScore on a closed profile.
  const isClosed = profile.status === 'released' || profile.status === 'forfeited';
  const { eligible, commitmentScore: score, suggestedCeiling } = isClosed
    ? { eligible: false, commitmentScore: 0, suggestedCeiling: 0 }
    : commitmentScore.computeScore({ heldAmount: profile.heldAmount, requestedAmount: profile.requestedAmount });

  const updated = await prisma.collateralProfile.update({
    where: { id: collateralProfileId },
    data: {
      eligible,
      commitmentScore: score,
      suggestedCeiling,
      status: eligible && profile.status === 'pending' ? 'active' : profile.status,
    },
  });

  await prisma.collateralEvent.create({
    data: { collateralProfileId, eventType: 'recomputed', note, actor },
  });

  return updated;
}

// Called from the Nomba webhook path when cash lands in a trader's collateral virtual account.
async function recordCashReceived({ traderId, amount, webhookRef }) {
  const trader = await prisma.trader.findUnique({
    where: { id: traderId },
    include: {
      suppliers: {
        include: { collateralProfile: true },
      },
    },
  });
  if (!trader) throw new CollateralError(404, 'Trader not found');

  // MVP: a trader has (at most) one active collateral profile awaiting cash at a time —
  // route the deposit to whichever profile is still pending/active. If none exists, the
  // deposit is just recorded on the trader's aggregate pending balance for manual reconciliation.
  const profile = trader.suppliers
    .map((s) => s.collateralProfile)
    .find((p) => p && (p.status === 'pending' || p.status === 'active'));

  await prisma.trader.update({
    where: { id: traderId },
    data: { collateralHeldPending: { increment: amount } },
  });

  if (!profile) return null;

  await prisma.collateralProfile.update({
    where: { id: profile.id },
    // A new deposit changes the held ratio — invalidate any prior supplier approval.
    data: { heldAmount: { increment: amount }, reviewStatus: 'pending', reviewedAt: null },
  });
  await prisma.collateralEvent.create({
    data: { collateralProfileId: profile.id, eventType: 'deposit', amount, note: webhookRef, actor: 'system' },
  });

  return recompute(profile.id, { actor: 'system', note: 'Recomputed after cash deposit' });
}

// Supplier's review of the collateral's CURRENT state, distinct from the lifecycle `status`
// field above. No recompute() needed — review doesn't affect eligible/score/ceiling.
async function approveProfile(collateralProfileId, { actor = 'supplier', note } = {}) {
  const profile = await prisma.collateralProfile.update({
    where: { id: collateralProfileId },
    data: { reviewStatus: 'approved', reviewedAt: new Date() },
  });
  await prisma.collateralEvent.create({
    data: { collateralProfileId, eventType: 'approved', note, actor },
  });
  return profile;
}

async function rejectProfile(collateralProfileId, { actor = 'supplier', note } = {}) {
  const profile = await prisma.collateralProfile.update({
    where: { id: collateralProfileId },
    data: { reviewStatus: 'rejected', reviewedAt: new Date() },
  });
  await prisma.collateralEvent.create({
    data: { collateralProfileId, eventType: 'rejected', note, actor },
  });
  return profile;
}

async function releaseProfile(collateralProfileId, { actor = 'supplier', note } = {}) {
  const profile = await prisma.collateralProfile.update({
    where: { id: collateralProfileId },
    data: { status: 'released', releasedAt: new Date() },
  });
  await prisma.collateralEvent.create({
    data: { collateralProfileId, eventType: 'released', note, actor },
  });
  return recompute(collateralProfileId, { actor, note: 'Recomputed after release' });
}

async function forfeitProfile(collateralProfileId, { actor = 'supplier', note } = {}) {
  const profile = await prisma.collateralProfile.update({
    where: { id: collateralProfileId },
    data: { status: 'forfeited', forfeitedAt: new Date() },
  });
  await prisma.collateralEvent.create({
    data: { collateralProfileId, eventType: 'forfeited', note, actor },
  });
  return recompute(collateralProfileId, { actor, note: 'Recomputed after forfeit' });
}

// Best-effort hook called from split.js when a linked CreditLedger clears — releases any
// still-held collateral for that relationship. Not part of the same DB transaction as the
// repayment processing, matching how other non-critical side effects are handled there.
async function autoReleaseOnClear(creditLedgerId) {
  const ledger = await prisma.creditLedger.findUnique({ where: { id: creditLedgerId } });
  if (!ledger?.collateralProfileId) return;

  const profile = await prisma.collateralProfile.findUnique({ where: { id: ledger.collateralProfileId } });
  if (!profile || profile.status === 'released' || profile.status === 'forfeited') return;

  await releaseProfile(profile.id, { actor: 'system', note: 'Auto-released: linked credit ledger cleared' });
}

module.exports = {
  CollateralError,
  ensureCollateralAccount,
  getOrCreateProfile,
  updateRequestedAmount,
  recompute,
  recordCashReceived,
  approveProfile,
  rejectProfile,
  releaseProfile,
  forfeitProfile,
  autoReleaseOnClear,
};
