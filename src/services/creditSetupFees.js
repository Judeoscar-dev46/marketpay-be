const MYCOVER_PREMIUM_PCT = Number(process.env.MYCOVER_PREMIUM_PCT || 2.5);
const CREDIT_SETUP_FEE_PCT = Number(process.env.CREDIT_SETUP_FEE_PCT || 2);
const FEE_PAYER = 'supplier';

function pctOfKobo(amountKobo, pct) {
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) return 0;
  return Math.floor(amountKobo * (pct / 100));
}

function computeQuote(creditAmountKobo, { collateralDepositKobo = 0, collateralHeldKobo = 0 } = {}) {
  const creditAmount = Number.isInteger(creditAmountKobo) && creditAmountKobo > 0 ? creditAmountKobo : 0;
  const collateralDeposit = Number.isInteger(collateralDepositKobo) && collateralDepositKobo > 0 ? collateralDepositKobo : 0;
  const collateralHeld = Number.isInteger(collateralHeldKobo) && collateralHeldKobo > 0 ? collateralHeldKobo : 0;

  const mycoverPremium = pctOfKobo(creditAmount, MYCOVER_PREMIUM_PCT);
  const platformSetupFee = pctOfKobo(creditAmount, CREDIT_SETUP_FEE_PCT);
  const totalFees = mycoverPremium + platformSetupFee;

  return {
    creditAmount,
    payer: FEE_PAYER,
    collateralDeposit,
    collateralHeld,
    mycoverPremiumPct: MYCOVER_PREMIUM_PCT,
    platformSetupFeePct: CREDIT_SETUP_FEE_PCT,
    mycoverPremium,
    platformSetupFee,
    totalFees,
    // Supplier pays fees only — trader collateral is separate escrow, not part of fee total
    totalDue: totalFees,
  };
}

function isPlatformFeeSatisfied(ledger) {
  if (!ledger) return false;
  const status = ledger.platformSetupFeeStatus;
  if (status === 'paid' || status === 'accruing') return true;
  const amount = ledger.platformSetupFeeAmount || 0;
  if (amount <= 0) return true;
  return (ledger.platformSetupFeeCollected || 0) >= amount;
}

function feeFieldsForCreditAmount(creditAmountKobo, existing = {}) {
  const quote = computeQuote(creditAmountKobo);
  const collected = existing.platformSetupFeeCollected || 0;
  const amount = quote.platformSetupFee;

  let status = existing.platformSetupFeeStatus || 'pending';
  if (amount <= collected) {
    status = 'paid';
  } else if (status === 'paid' && amount > collected) {
    // Credit topped up — more fee is due
    status = 'pending';
  } else if (status === 'accruing' && amount > collected) {
    status = 'accruing';
  }

  return {
    platformSetupFeeAmount: amount,
    platformSetupFeeStatus: status,
    platformSetupFeeCollected: collected,
    platformSetupFeePaidAt: status === 'paid' ? (existing.platformSetupFeePaidAt || new Date()) : existing.platformSetupFeePaidAt || null,
    platformSetupFeeMethod: existing.platformSetupFeeMethod || null,
  };
}

module.exports = {
  MYCOVER_PREMIUM_PCT,
  CREDIT_SETUP_FEE_PCT,
  FEE_PAYER,
  pctOfKobo,
  computeQuote,
  isPlatformFeeSatisfied,
  feeFieldsForCreditAmount,
};
