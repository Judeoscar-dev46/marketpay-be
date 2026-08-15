class KycRequiredError extends Error {
  constructor(message = 'Complete KYC to continue') {
    super(message);
    this.status = 403;
    this.code = 'KYC_REQUIRED';
  }
}

function isIdentityKycComplete(trader) {
  return trader?.kycStatus === 'submitted' && !!trader.bankCode && !!trader.accountNumber;
}

function isFootprintComplete(trader) {
  return Boolean(
    trader?.market?.trim()
    && trader?.marketArea?.trim()
    && trader?.stallLandmark?.trim()
    && trader?.neighbourName?.trim()
    && trader?.neighbourContact?.trim()
  );
}

function isKycComplete(trader) {
  return isIdentityKycComplete(trader) && isFootprintComplete(trader);
}

function assertKycComplete(trader, message) {
  if (!isKycComplete(trader)) {
    throw new KycRequiredError(message);
  }
}

module.exports = {
  KycRequiredError,
  isIdentityKycComplete,
  isFootprintComplete,
  isKycComplete,
  assertKycComplete,
};
