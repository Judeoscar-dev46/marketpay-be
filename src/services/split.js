const prisma = require('../lib/prisma');
const nomba = require('./nomba');
const collateral = require('./collateral');
const { isSupplierKycComplete } = require('../lib/kyc');

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
      trader: { include: { suppliers: { where: { archivedAt: null }, include: { creditLedger: true, supplierUser: true } } } },
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
    if (supplier.mode === 'credit_repayment' && ledger) {
      if (!isSupplierKycComplete(supplier.supplierUser)) {
        // Credit repayments stay in the till until the supplier completes KYC.
        continue;
      }
      if (
        ledger.status === 'disputed' || ledger.status === 'cleared' || ledger.status === 'overpaid'
        || ledger.confirmationStatus !== 'confirmed'
        || !ledger.goodsReleased
      ) {
        // Frozen/resolved, not yet confirmed, or goods not yet released — this sale's share folds back into till.
        continue;
      }
    }

    const floor = applyMinimumFloor(share, supplier.accumulatedPending);
    if (floor.transferNow === 0) {
      supplierUpdates.push({ id: supplier.id, data: { accumulatedPending: floor.newPending } });
      continue;
    }

    // Supplier-paid MarketPay credit setup fee: skim from repayments/restock while accruing.
    let setupFeeSkim = 0;
    if (
      ledger
      && ledger.platformSetupFeeStatus === 'accruing'
      && (ledger.platformSetupFeeCollected || 0) < (ledger.platformSetupFeeAmount || 0)
    ) {
      const feeRemaining = ledger.platformSetupFeeAmount - (ledger.platformSetupFeeCollected || 0);
      setupFeeSkim = Math.min(feeRemaining, floor.transferNow);
    }

    const reference = `${tx.id}-supplier-${supplier.id}`;
    let result = { transferRef: null, status: 'skipped' };

    if (setupFeeSkim > 0) {
      let feeOk = true;
      if (process.env.PLATFORM_FEE_ACCOUNT_ID) {
        const feeResult = await safeTransfer(() =>
          nomba.initiateTransfer({
            from: trader.mainVirtualAccountId,
            to: process.env.PLATFORM_FEE_ACCOUNT_ID,
            amount: setupFeeSkim,
            reference: `${tx.id}-setup-fee-${supplier.id}`,
          })
        );
        splitRows.push({
          type: 'credit_setup_fee',
          supplierId: supplier.id,
          amount: setupFeeSkim,
          transferRef: feeResult.transferRef,
          status: feeResult.status,
        });
        feeOk = feeResult.status === 'success';
      } else {
        splitRows.push({
          type: 'credit_setup_fee',
          supplierId: supplier.id,
          amount: setupFeeSkim,
          transferRef: `stub-setup-fee-${supplier.id}`,
          status: 'success',
        });
      }

      if (feeOk) {
        ledger.platformSetupFeeCollected = (ledger.platformSetupFeeCollected || 0) + setupFeeSkim;
        if (ledger.platformSetupFeeCollected >= ledger.platformSetupFeeAmount) {
          ledger.platformSetupFeeStatus = 'paid';
        }
      } else {
        setupFeeSkim = 0;
      }
    }

    const payoutAmount = floor.transferNow - setupFeeSkim;
    if (payoutAmount > 0) {
      if (supplier.payoutSchedule === 'immediate') {
        result = await safeTransfer(() =>
          nomba.payToBank({
            fromAccountId: trader.mainVirtualAccountId,
            accountNumber: supplier.accountNumber,
            accountName: supplier.resolvedAccountName || supplier.name,
            bankCode: supplier.bankCode,
            amount: payoutAmount,
            reference,
            senderName: trader.name,
            narration: `MarketPay ${supplier.mode === 'credit_repayment' ? 'repayment' : 'restock'} — ${supplier.name}`,
          })
        );
      } else {
        result = await safeTransfer(() =>
          nomba.initiateTransfer({
            from: trader.mainVirtualAccountId,
            to: supplier.virtualAccountId,
            amount: payoutAmount,
            reference,
          })
        );
      }

      splitRows.push({ type: 'supplier', supplierId: supplier.id, amount: payoutAmount, transferRef: result.transferRef, status: result.status });
    }

    const updateData = { accumulatedPending: floor.newPending };
    // Non-immediate schedules land in the supplier's own held sub-account rather than their
    // bank directly — track the running balance so there's something to pay out later.
    if (supplier.payoutSchedule !== 'immediate' && result.status === 'success' && payoutAmount > 0) {
      updateData.heldBalance = { increment: payoutAmount };
    }
    supplierUpdates.push({ id: supplier.id, data: updateData });

    if (setupFeeSkim > 0) {
      creditEvents.push({
        kind: 'setup_fee_skim',
        ledgerId: ledger.id,
        setupFeeCollected: ledger.platformSetupFeeCollected,
        setupFeeStatus: ledger.platformSetupFeeStatus,
        setupFeeAmount: ledger.platformSetupFeeAmount,
      });
    }

    if (supplier.mode === 'credit_repayment' && ledger && result.status === 'success' && payoutAmount > 0) {
      const newRepaid = ledger.totalRepaid + payoutAmount;
      const newOutstanding = ledger.outstandingBalance - payoutAmount;
      const cleared = newOutstanding <= 0;
      creditEvents.push({
        kind: 'repayment',
        ledgerId: ledger.id,
        repaymentAmount: payoutAmount,
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
      const event = creditEvents.find((e) => e.kind === 'repayment' && e.supplierId === row.supplierId && row.type === 'supplier');
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
      if (event.kind === 'setup_fee_skim') {
        await txClient.creditLedger.update({
          where: { id: event.ledgerId },
          data: {
            platformSetupFeeCollected: event.setupFeeCollected,
            platformSetupFeeStatus: event.setupFeeStatus,
            platformSetupFeePaidAt: event.setupFeeStatus === 'paid' ? new Date() : undefined,
          },
        });
        await txClient.creditLedgerEvent.create({
          data: {
            creditLedgerId: event.ledgerId,
            eventType: event.setupFeeStatus === 'paid' ? 'setup_fee_paid' : 'setup_fee_accruing',
            newAmount: event.setupFeeCollected,
            actor: 'system',
            note: `Setup fee collected via sale split (${event.setupFeeCollected}/${event.setupFeeAmount} kobo)`,
          },
        });
        continue;
      }

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
    if (event.cleared) {
      // Best-effort, outside the DB transaction above — mirrors how the restock-fallback
      // mode switch is also treated as a non-critical side effect of clearing.
      collateral.autoReleaseOnClear(event.ledgerId).catch((err) => {
        console.error('autoReleaseOnClear failed for ledger', event.ledgerId, err);
      });
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
