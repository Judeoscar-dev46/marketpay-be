require('dotenv').config();
const prisma = require('../src/lib/prisma');

// When Nomba sandbox credentials aren't available yet, use stub accounts
const USE_STUB = process.env.USE_STUB_ACCOUNTS === 'true' || !process.env.NOMBA_CLIENT_ID;

async function createVirtualAccount(name, ref) {
  if (USE_STUB) {
    return {
      accountId: `stub-${ref}`,
      accountNumber: `00${Math.floor(10000000 + Math.random() * 90000000)}`,
    };
  }
  const nomba = require('../src/services/nomba');
  return nomba.createVirtualAccount({ name, reference: ref });
}

async function main() {
  console.log('Seeding MarketPay demo data...');

  const personas = [
    { name: 'Amaka', business: 'Cooked food (jollof, stew, rice)', market: 'Roadside bukka, Lagos', avatar: 'amaka' },
    { name: 'Chidi', business: 'Aba-made fabric & ready-to-wear', market: 'Open-air market stall', avatar: 'chidi' },
  ];

  for (const persona of personas) {
    // Skip if already seeded
    const existing = await prisma.trader.findFirst({ where: { name: persona.name } });
    if (existing) {
      console.log(`Skipping ${persona.name} — already seeded`);
      continue;
    }

    console.log(`Creating virtual accounts for ${persona.name}...`);

    const [main, supplier, savings] = await Promise.all([
      createVirtualAccount(`${persona.name} Main Till`, `${persona.name.toLowerCase()}-main`),
      createVirtualAccount(`${persona.name} Supplier`, `${persona.name.toLowerCase()}-supplier`),
      createVirtualAccount(`${persona.name} Savings`, `${persona.name.toLowerCase()}-savings`),
    ]);

    const trader = await prisma.trader.create({
      data: {
        name: persona.name,
        business: persona.business,
        market: persona.market,
        avatar: persona.avatar,
        mainVirtualAccountId: main.accountId,
        mainAccountNumber: main.accountNumber,
        supplierAccountId: supplier.accountId,
        supplierAccountNumber: supplier.accountNumber,
        savingsAccountId: savings.accountId,
        savingsAccountNumber: savings.accountNumber,
      },
    });

    console.log(`Created trader: ${trader.name} (${trader.id})`);

    // Seed 7 days of transaction history
    const sampleAmounts = [
      [250000, 150000, 320000, 180000],
      [500000, 275000, 420000],
      [310000, 190000, 450000, 220000, 160000],
      [380000, 290000],
      [600000, 415000, 230000],
      [270000, 340000, 180000, 510000],
      [450000, 320000],
    ];

    for (let d = 6; d >= 0; d--) {
      const date = new Date();
      date.setDate(date.getDate() - d);
      date.setHours(0, 0, 0, 0);

      const dayAmounts = sampleAmounts[d] || [300000, 200000];
      let totalSales = 0, totalSupplier = 0, totalSavings = 0, totalTill = 0;

      for (let i = 0; i < dayAmounts.length; i++) {
        const amount = dayAmounts[i];
        const supplierAmt = Math.floor(amount * 0.2);
        const savingsAmt = Math.floor(amount * 0.1);
        const tillAmt = amount - supplierAmt - savingsAmt;

        const txDate = new Date(date);
        txDate.setHours(8 + i * 2, Math.floor(Math.random() * 60), 0, 0);

        const tx = await prisma.transaction.create({
          data: {
            traderId: trader.id,
            amount,
            status: 'confirmed',
            checkoutRef: `seed-${trader.id}-${d}-${i}`,
            webhookRef: `seed-webhook-${trader.id}-${d}-${i}`,
            workingCapital: tillAmt,
            supplierAmount: supplierAmt,
            savingsAmount: savingsAmt,
            createdAt: txDate,
            updatedAt: txDate,
          },
        });

        await prisma.splitTransfer.createMany({
          data: [
            { transactionId: tx.id, type: 'supplier', amount: supplierAmt, status: 'success', transferRef: `seed-sup-${tx.id}` },
            { transactionId: tx.id, type: 'savings', amount: savingsAmt, status: 'success', transferRef: `seed-sav-${tx.id}` },
          ],
        });

        totalSales += amount;
        totalSupplier += supplierAmt;
        totalSavings += savingsAmt;
        totalTill += tillAmt;
      }

      await prisma.dailyLedger.upsert({
        where: { traderId_date: { traderId: trader.id, date } },
        create: {
          traderId: trader.id,
          date,
          totalSales,
          totalSupplier,
          totalSavings,
          totalTillBalance: totalTill,
          txCount: dayAmounts.length,
        },
        update: {
          totalSales,
          totalSupplier,
          totalSavings,
          totalTillBalance: totalTill,
          txCount: dayAmounts.length,
        },
      });

      console.log(`  Seeded ${persona.name} day -${d}: ${dayAmounts.length} transactions, NGN ${(totalSales / 100).toFixed(2)}`);
    }
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
