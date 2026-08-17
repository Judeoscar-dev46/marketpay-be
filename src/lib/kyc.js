class KycRequiredError extends Error {
  constructor(message = 'Complete KYC to continue', code = 'KYC_REQUIRED') {
    super(message);
    this.status = 403;
    this.code = code;
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

function isSupplierKycComplete(supplierUser) {
  return Boolean(
    supplierUser
    && supplierUser.kycStatus === 'submitted'
    && supplierUser.bvn
    && supplierUser.bankCode
    && supplierUser.accountNumber
    && supplierUser.accountNameVerified
  );
}

function assertSupplierKycComplete(
  supplierUser,
  message = 'This supplier must sign in and complete KYC before continuing',
) {
  if (!isSupplierKycComplete(supplierUser)) {
    throw new KycRequiredError(message, 'SUPPLIER_KYC_REQUIRED');
  }
}

function toPublicSupplierUser(user) {
  if (!user) return null;
  const { bvn, ...rest } = user;
  return {
    ...rest,
    kycComplete: isSupplierKycComplete(user),
    bvnSubmitted: !!bvn,
  };
}

function supplierKycSelect() {
  return {
    id: true,
    kycStatus: true,
    bvn: true,
    bankCode: true,
    accountNumber: true,
    accountNameVerified: true,
  };
}

module.exports = {
  KycRequiredError,
  isIdentityKycComplete,
  isFootprintComplete,
  isKycComplete,
  assertKycComplete,
  isSupplierKycComplete,
  assertSupplierKycComplete,
  toPublicSupplierUser,
  supplierKycSelect,
};
