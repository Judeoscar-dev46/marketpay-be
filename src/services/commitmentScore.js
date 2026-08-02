const MIN_ELIGIBLE_RATIO_PCT = 10;

// Fixed tiers on collateral-to-goods ratio. Ordered highest-first so the first match wins.
const TIERS = [
  { min: 70, multiplier: 2.0 },
  { min: 40, multiplier: 1.5 },
  { min: 20, multiplier: 1.2 },
  { min: MIN_ELIGIBLE_RATIO_PCT, multiplier: 1.0 },
];

function computeRatioPct(heldAmount, requestedAmount) {
  if (!requestedAmount) return 0;
  return (heldAmount / requestedAmount) * 100;
}

function tierMultiplier(ratioPct) {
  const tier = TIERS.find((t) => ratioPct >= t.min);
  return tier ? tier.multiplier : 0;
}

function computeScore({ heldAmount, requestedAmount }) {
  const ratioPct = computeRatioPct(heldAmount, requestedAmount);
  const eligible = ratioPct >= MIN_ELIGIBLE_RATIO_PCT;
  const commitmentScore = eligible ? tierMultiplier(ratioPct) : 0;
  const suggestedCeiling = eligible ? Math.round(requestedAmount * commitmentScore) : 0;
  return { eligible, ratioPct, commitmentScore, suggestedCeiling };
}

module.exports = { MIN_ELIGIBLE_RATIO_PCT, computeRatioPct, tierMultiplier, computeScore };
