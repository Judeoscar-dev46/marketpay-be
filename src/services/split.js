const prisma = require('../lib/prisma');
const nomba = require('./nomba');

// Map<traderId, Set<res>> — SSE clients
const sseClients = new Map();

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

async function processPayment(transactionId) {
  const tx = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: { trader: true },
  });

  if (!tx || tx.status !== 'confirmed') return;

  const total = tx.amount;
  const supplierAmt = Math.floor(total * 0.2);
  const savingsAmt = Math.floor(total * 0.1);
  const tillAmt = total - supplierAmt - savingsAmt;

  const [supplierResult, savingsResult] = await Promise.allSettled([
    nomba.initiateTransfer({
      from: tx.trader.mainVirtualAccountId,
      to: tx.trader.supplierAccountId,
      amount: supplierAmt,
      reference: `${tx.id}-supplier`,
    }),
    nomba.initiateTransfer({
      from: tx.trader.mainVirtualAccountId,
      to: tx.trader.savingsAccountId,
      amount: savingsAmt,
      reference: `${tx.id}-savings`,
    }),
  ]);

  await prisma.$transaction([
    prisma.splitTransfer.create({
      data: {
        transactionId: tx.id,
        type: 'supplier',
        amount: supplierAmt,
        transferRef: supplierResult.status === 'fulfilled' ? supplierResult.value.transferRef : null,
        status: supplierResult.status === 'fulfilled' ? 'success' : 'failed',
      },
    }),
    prisma.splitTransfer.create({
      data: {
        transactionId: tx.id,
        type: 'savings',
        amount: savingsAmt,
        transferRef: savingsResult.status === 'fulfilled' ? savingsResult.value.transferRef : null,
        status: savingsResult.status === 'fulfilled' ? 'success' : 'failed',
      },
    }),
    prisma.transaction.update({
      where: { id: tx.id },
      data: { workingCapital: tillAmt, supplierAmount: supplierAmt, savingsAmount: savingsAmt },
    }),
  ]);

  // Upsert DailyLedger
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  await prisma.dailyLedger.upsert({
    where: { traderId_date: { traderId: tx.traderId, date: today } },
    create: {
      traderId: tx.traderId,
      date: today,
      totalSales: total,
      totalSupplier: supplierAmt,
      totalSavings: savingsAmt,
      totalTillBalance: tillAmt,
      txCount: 1,
    },
    update: {
      totalSales: { increment: total },
      totalSupplier: { increment: supplierAmt },
      totalSavings: { increment: savingsAmt },
      totalTillBalance: { increment: tillAmt },
      txCount: { increment: 1 },
    },
  });

  const updated = await prisma.transaction.findUnique({
    where: { id: tx.id },
    include: { splitTransfers: true },
  });

  emitToTrader(tx.traderId, { type: 'payment_confirmed', transaction: updated });
}

module.exports = { processPayment, registerSseClient, removeSseClient, emitToTrader };
