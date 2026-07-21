const prisma = require('../lib/prisma');

const MAX_SUPPLIERS = 3;

function activeSupplierWhere(traderId) {
  return { traderId, archivedAt: null };
}

// Throws { status, message } if adding/changing a supplier to allocationPct would violate
// the max-supplier-count cap or exceed the trader's configured supplierPct ceiling.
// Shared by the manual-add flow (suppliers.js) and the invite-redemption flow (supplierInvites.js)
// so the two paths can never silently drift apart on this rule.
async function assertAllocationFits({ traderId, allocationPct, excludeSupplierId, trader }) {
  const resolvedTrader = trader || (await prisma.trader.findUnique({ where: { id: traderId } }));
  if (!resolvedTrader) {
    const err = new Error('Trader not found');
    err.status = 404;
    throw err;
  }

  const where = excludeSupplierId
    ? { ...activeSupplierWhere(traderId), id: { not: excludeSupplierId } }
    : activeSupplierWhere(traderId);
  const existing = await prisma.supplier.findMany({ where });

  if (!excludeSupplierId && existing.length >= MAX_SUPPLIERS) {
    const err = new Error(`Maximum of ${MAX_SUPPLIERS} suppliers reached`);
    err.status = 400;
    throw err;
  }

  const allocatedByOthers = existing.reduce((sum, s) => sum + s.allocationPct, 0);
  if (allocatedByOthers + allocationPct > resolvedTrader.supplierPct) {
    const err = new Error(
      `Allocation exceeds available supplier split — ${resolvedTrader.supplierPct - allocatedByOthers}% remaining. Adjust Split Settings first if you need more.`
    );
    err.status = 400;
    throw err;
  }
}

module.exports = { MAX_SUPPLIERS, activeSupplierWhere, assertAllocationFits };
