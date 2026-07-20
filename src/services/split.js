const prisma = require('../lib/prisma');
const nomba = require('./nomba');

const MIN_TRANSFER = 10000; // ₦100 in kobo — Nomba's minimum transfer amount
const PLATFORM_FEE_PCT = Number(process.env.PLATFORM_FEE_PCT || 4);

// Map<traderId, Set<res>> — SSE clients
const sseClients = new Map();
// Map<supplierUserId, Set<res>> — SSE clients for the supplier dashboard
const supplierSseClients = new Map();

function registerSseClient(traderId, res) {
  if (!sseClients.has(traderId)) sseClients.set(traderId, new Set());
  sseClients.get(traderId).add(res);
}

function removeSseClient(traderId, res) {
  sseClients.get(traderId)?.delete(res);
}

function emitToTrader(traderId, payload) {
  const clients = sseClients.get(traderId);
  if (!clients || clients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}

function registerSupplierSseClient(supplierUserId, res) {
  if (!supplierSseClients.has(supplierUserId)) supplierSseClients.set(supplierUserId, new Set());
  supplierSseClients.get(supplierUserId).add(res);
}

function removeSupplierSseClient(supplierUserId, res) {
  supplierSseClients.get(supplierUserId)?.delete(res);
}

function emitToSupplierUser(supplierUserId, payload) {
  const clients = supplierSseClients.get(supplierUserId);
  if (!clients || clients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}

// Applies the ₦100-minimum accumulation rule: returns the amount to actually transfer now
// (0 if still below the floor) and the new pending balance to carry forward.
function applyMinimumFloor(shareThisSale, pendingCarry) {
  const combined = shareThisSale + pendingCarry;
  if (combined < MIN_TRANSFER) {
    return { transferNow: 0, newPending: combined };
  }
  return { transferNow: combined, newPending: 0 };
}

async function processPayment(transactionId) {
  const tx = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: {
      trader: { include: { suppliers: { where: { archivedAt: null }, include: { creditLedger: true } } } },
    },
  });

  if (!tx || tx.status !== 'confirmed') return;

  const total = tx.amount;
  const trader = tx.trader;
  const splitRows = [];

  // 1. Platform fee — off the top, before the trader's own split percentages apply.
  const platformFeeShare = Math.floor(total * (PLATFORM_FEE_PCT / 100));
  const platformFloor = applyMinimumFloor(platformFeeShare, trader.platformFeeAccumulatedPending);
  if (platformFloor.transferNow > 0 && process.env.PLATFORM_FEE_ACCOUNT_ID) {
    const result = await safeTransfer(() =>
      nomba.initiateTransfer({
        from: trader.mainVirtualAccountId,
        to: process.env.PLATFORM_FEE_ACCOUNT_ID,
        amount: platformFloor.transferNow,
        reference: `${tx.id}-platform-fee`,
      })
    );
    splitRows.push({ type: 'platform_fee', amount: platformFloor.transferNow, transferRef: result.transferRef, status: result.status });
  }

  // 2. Per-supplier legs — Restock and Credit Repayment modes, both timing options.
  const supplierUpdates = [];
  const creditEvents = [];

  for (const supplier of trader.suppliers) {
    const share = Math.floor(total * (supplier.allocationPct / 100));

    const ledger = supplier.creditLedger;
    if (supplier.mode === 'credit_repayment' && ledger && (ledger.status === 'disputed' || ledger.status === 'cleared' || ledger.status === 'overpaid')) {
      // Frozen (disputed) or nothing left to repay — this sale's share folds back into till.
      continue;
    }

    const floor = applyMinimumFloor(share, supplier.accumulatedPending);
    if (floor.transferNow === 0) {
      supplierUpdates.push({ id: supplier.id, data: { accumulatedPending: floor.newPending } });
      continue;
    }

    const reference = `${tx.id}-supplier-${supplier.id}`;
    let result;
    if (supplier.payoutSchedule === 'immediate') {
      result = await safeTransfer(() =>
        nomba.payToBank({
          fromAccountId: trader.mainVirtualAccountId,
          accountNumber: supplier.accountNumber,
          bankCode: supplier.bankCode,
          amount: floor.transferNow,
          reference,
          narration: `MarketPay ${supplier.mode === 'credit_repayment' ? 'repayment' : 'restock'} — ${supplier.name}`,
        })
      );
    } else {
      result = await safeTransfer(() =>
        nomba.initiateTransfer({
          from: trader.mainVirtualAccountId,
          to: supplier.virtualAccountId,
          amount: floor.transferNow,
          reference,
        })
      );
    }

    splitRows.push({ type: 'supplier', supplierId: supplier.id, amount: floor.transferNow, transferRef: result.transferRef, status: result.status });
    supplierUpdates.push({ id: supplier.id, data: { accumulatedPending: floor.newPending } });

    if (supplier.mode === 'credit_repayment' && ledger && result.status === 'success') {
      const newRepaid = ledger.totalRepaid + floor.transferNow;
      const newOutstanding = ledger.outstandingBalance - floor.transferNow;
      const cleared = newOutstanding <= 0;
      creditEvents.push({
        ledgerId: ledger.id,
        repaymentAmount: floor.transferNow,
        newTotalRepaid: newRepaid,
        newOutstanding: Math.max(newOutstanding, 0),
        overpaidAmount: cleared ? Math.max(-newOutstanding, 0) : 0,
        cleared,
        supplierId: supplier.id,
        restockFallbackPct: supplier.restockFallbackPct,
      });
    }
  }

  // 3. Savings — unchanged mechanic, now with the same ₦100 floor/accumulation as supplier legs.
  const savingsShare = Math.floor(total * (trader.savingsPct / 100));
  const savingsFloor = applyMinimumFloor(savingsShare, trader.savingsAccumulatedPending);
  if (savingsFloor.transferNow > 0) {
    const result = await safeTransfer(() =>
      nomba.initiateTransfer({
        from: trader.mainVirtualAccountId,
        to: trader.savingsAccountId,
        amount: savingsFloor.transferNow,
        reference: `${tx.id}-savings`,
      })
    );
    splitRows.push({ type: 'savings', amount: savingsFloor.transferNow, transferRef: result.transferRef, status: result.status });
  }

  // 4. Till — everything not actually transferred out this sale (accumulated-pending amounts,
  // disputed/cleared credit-line shares, and rounding remainder all fold back in here).
  const actuallyTransferredOut = splitRows.reduce((s, r) => s + r.amount, 0);
  const tillFinal = total - actuallyTransferredOut;

  await prisma.$transaction(async (txClient) => {
    for (const row of splitRows) {
      const created = await txClient.splitTransfer.create({
        data: {
          transactionId: tx.id,
          type: row.type,
          supplierId: row.supplierId || null,
          amount: row.amount,
          transferRef: row.transferRef,
          status: row.status,
        },
      });
      const event = creditEvents.find((e) => e.supplierId === row.supplierId && row.type === 'supplier');
      if (event) event.splitTransferId = created.id;
    }

    for (const update of supplierUpdates) {
      await txClient.supplier.update({ where: { id: update.id }, data: update.data });
    }

    await txClient.trader.update({
      where: { id: trader.id },
      data: {
        platformFeeAccumulatedPending: platformFloor.newPending,
        savingsAccumulatedPending: savingsFloor.newPending,
      },
    });

    for (const event of creditEvents) {
      await txClient.creditRepayment.create({
        data: {
          creditLedgerId: event.ledgerId,
          splitTransferId: event.splitTransferId || null,
          amount: event.repaymentAmount,
          runningBalance: event.newOutstanding,
        },
      });
      await txClient.creditLedger.update({
        where: { id: event.ledgerId },
        data: {
          totalRepaid: event.newTotalRepaid,
          outstandingBalance: event.newOutstanding,
          overpaidAmount: event.overpaidAmount,
          status: event.cleared ? (event.overpaidAmount > 0 ? 'overpaid' : 'cleared') : 'active',
          clearedAt: event.cleared ? new Date() : null,
        },
      });
      await txClient.creditLedgerEvent.create({
        data: {
          creditLedgerId: event.ledgerId,
          eventType: 'repayment',
          newAmount: event.newOutstanding,
          actor: 'system',
          note: `Repayment of ${event.repaymentAmount} kobo`,
        },
      });
      if (event.cleared) {
        await txClient.creditLedgerEvent.create({
          data: {
            creditLedgerId: event.ledgerId,
            eventType: event.overpaidAmount > 0 ? 'overpaid' : 'cleared',
            actor: 'system',
          },
        });
        // Fall back to Restock mode at a lower pre-configured % once the debt clears, if configured.
        if (event.restockFallbackPct) {
          await txClient.supplier.update({
            where: { id: event.supplierId },
            data: { mode: 'restock', allocationPct: event.restockFallbackPct },
          });
        }
      }
    }

    const supplierTotalOut = splitRows.filter((r) => r.type === 'supplier').reduce((s, r) => s + r.amount, 0);
    await txClient.transaction.update({
      where: { id: tx.id },
      data: { workingCapital: tillFinal, supplierAmount: supplierTotalOut, savingsAmount: savingsFloor.transferNow },
    });
  }, { timeout: 20000 });

  // Upsert DailyLedger
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const supplierTotalThisTx = splitRows.filter((r) => r.type === 'supplier').reduce((s, r) => s + r.amount, 0);

  await prisma.dailyLedger.upsert({
    where: { traderId_date: { traderId: tx.traderId, date: today } },
    create: {
      traderId: tx.traderId,
      date: today,
      totalSales: total,
      totalSupplier: supplierTotalThisTx,
      totalSavings: savingsFloor.transferNow,
      totalTillBalance: tillFinal,
      txCount: 1,
    },
    update: {
      totalSales: { increment: total },
      totalSupplier: { increment: supplierTotalThisTx },
      totalSavings: { increment: savingsFloor.transferNow },
      totalTillBalance: { increment: tillFinal },
      txCount: { increment: 1 },
    },
  });

  const updated = await prisma.transaction.findUnique({
    where: { id: tx.id },
    include: { splitTransfers: { include: { supplier: true } } },
  });

  emitToTrader(tx.traderId, { type: 'payment_confirmed', transaction: updated });

  for (const event of creditEvents) {
    const supplier = trader.suppliers.find((s) => s.id === event.supplierId);
    if (supplier?.supplierUserId) {
      emitToSupplierUser(supplier.supplierUserId, { type: 'credit_repayment', supplierId: supplier.id });
    }
  }
}

async function safeTransfer(fn) {
  try {
    const result = await fn();
    return { transferRef: result.transferRef, status: 'success' };
  } catch (err) {
    console.error('Split transfer failed:', err?.response?.data || err.message || err);
    return { transferRef: null, status: 'failed' };
  }
}

module.exports = {
  processPayment,
  registerSseClient,
  removeSseClient,
  emitToTrader,
  registerSupplierSseClient,
  removeSupplierSseClient,
  emitToSupplierUser,
};
