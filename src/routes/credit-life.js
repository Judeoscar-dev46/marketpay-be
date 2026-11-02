const express = require('express');
const prisma = require('../lib/prisma');
const { requireAuth, requireSupplier } = require('../middleware/auth');
const mycover = require('../services/mycover');
const creditSetupFees = require('../services/creditSetupFees');

const router = express.Router();

async function loadLedgerForViewer(ledgerId, auth) {
  const ledger = await prisma.creditLedger.findUnique({
    where: { id: ledgerId },
    include: {
      creditLifePolicy: true,
      supplier: {
        include: {
          trader: true,
          supplierUser: true,
          collateralProfile: true,
        },
      },
    },
  });
  if (!ledger) return null;

  const isTrader = auth.role === 'trader' && ledger.supplier.traderId === auth.id;
  const isSupplier = auth.role === 'supplier' && ledger.supplier.supplierUserId === auth.id;
  if (!isTrader && !isSupplier) return null;
  return ledger;
}

function buildSetupQuote(ledger) {
  const profile = ledger.supplier?.collateralProfile;
  const quote = creditSetupFees.computeQuote(ledger.creditAmount, {
    collateralDepositKobo: profile?.requestedAmount || 0,
    collateralHeldKobo: profile?.heldAmount || 0,
  });
  const collected = ledger.platformSetupFeeCollected || 0;
  const amount = ledger.platformSetupFeeAmount || quote.platformSetupFee;
  return {
    ...quote,
    platformSetupFee: amount,
    platformSetupFeeCollected: collected,
    platformSetupFeeRemaining: Math.max(0, amount - collected),
    platformSetupFeeStatus: ledger.platformSetupFeeStatus || 'pending',
    platformSetupFeeMethod: ledger.platformSetupFeeMethod || null,
    feeSatisfied: creditSetupFees.isPlatformFeeSatisfied({
      ...ledger,
      platformSetupFeeAmount: amount,
    }),
  };
}

async function ensurePendingPolicy(ledger) {
  let policy = ledger.creditLifePolicy;
  if (!policy) {
    policy = await prisma.creditLifePolicy.create({
      data: {
        creditLedgerId: ledger.id,
        status: 'pending',
        merchantRef: mycover.newMerchantRef(),
        productId: mycover.creditLifeProductId(),
      },
    });
  } else if (!mycover.isCovering(policy, ledger.creditAmount)) {
    const reusePending = policy.status === 'pending' && policy.merchantRef;
    policy = await prisma.creditLifePolicy.update({
      where: { id: policy.id },
      data: {
        status: 'pending',
        merchantRef: reusePending ? policy.merchantRef : mycover.newMerchantRef(),
        productId: policy.productId || mycover.creditLifeProductId(),
      },
    });
  }
  return policy;
}

// POST /api/credit-life/session — supplier (or trader view) starts Credit Life purchase
// Fees are paid by the supplier; only suppliers may open MyCover checkout.
router.post('/session', requireAuth, async (req, res) => {
  const { ledgerId } = req.body;
  if (!ledgerId) return res.status(400).json({ error: 'ledgerId is required' });

  try {
    const ledger = await loadLedgerForViewer(ledgerId, req.auth);
    if (!ledger) return res.status(404).json({ error: 'Credit entry not found' });

    const isSupplier = req.auth.role === 'supplier';
    if (!isSupplier && req.auth.role !== 'trader') {
      return res.status(403).json({ error: 'Not allowed' });
    }

    // Traders can inspect session status but cannot purchase — supplier pays.
    if (!isSupplier) {
      const covering = mycover.isCovering(ledger.creditLifePolicy, ledger.creditAmount);
      return res.json({
        data: {
          covering,
          stub: mycover.isStub(),
          creditAmount: ledger.creditAmount,
          policy: mycover.toPublicPolicy(ledger.creditLifePolicy, ledger.creditAmount),
          setupQuote: buildSetupQuote(ledger),
          purchaseAllowed: false,
          message: 'The supplier pays Credit Life and MarketPay setup fees for this credit line.',
        },
      });
    }

    const supplierUser = ledger.supplier.supplierUser;
    const policy = await ensurePendingPolicy(ledger);
    const covering = mycover.isCovering(policy, ledger.creditAmount);
    const firstName = (supplierUser?.name || ledger.supplier.name || '').trim().split(/\s+/)[0] || '';

    res.json({
      data: {
        publicKey: mycover.publicKey(),
        productId: mycover.creditLifeProductId(),
        reference: policy.merchantRef,
        covering,
        stub: mycover.isStub(),
        creditAmount: ledger.creditAmount,
        policy: mycover.toPublicPolicy(policy, ledger.creditAmount),
        prefill: {
          firstName,
          phone: supplierUser?.phone || ledger.supplier.phone || '',
        },
        setupQuote: buildSetupQuote(ledger),
        purchaseAllowed: true,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to start Credit Life session' });
  }
});

// GET /api/credit-life/ledger/:ledgerId — trader or that supplier; policy status for UI
router.get('/ledger/:ledgerId', requireAuth, async (req, res) => {
  try {
    const ledger = await loadLedgerForViewer(req.params.ledgerId, req.auth);
    if (!ledger) return res.status(404).json({ error: 'Credit entry not found' });

    res.json({
      data: {
        ledgerId: ledger.id,
        creditAmount: ledger.creditAmount,
        covering: mycover.isCovering(ledger.creditLifePolicy, ledger.creditAmount),
        stub: mycover.isStub(),
        policy: mycover.toPublicPolicy(ledger.creditLifePolicy, ledger.creditAmount),
        setupQuote: buildSetupQuote(ledger),
        purchaseAllowed: req.auth.role === 'supplier',
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch Credit Life status' });
  }
});

// GET /api/credit-life/ledger/:ledgerId/setup-quote
router.get('/ledger/:ledgerId/setup-quote', requireAuth, async (req, res) => {
  try {
    const ledger = await loadLedgerForViewer(req.params.ledgerId, req.auth);
    if (!ledger) return res.status(404).json({ error: 'Credit entry not found' });
    res.json({ data: buildSetupQuote(ledger) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute setup quote' });
  }
});

// POST /api/credit-life/simulate — stub-only; supplier activates cover without MyCover
router.post('/simulate', requireAuth, requireSupplier, async (req, res) => {
  if (!mycover.isStub()) {
    return res.status(404).json({ error: 'Not found' });
  }

  const { ledgerId } = req.body;
  if (!ledgerId) return res.status(400).json({ error: 'ledgerId is required' });

  try {
    const ledger = await loadLedgerForViewer(ledgerId, req.auth);
    if (!ledger || req.auth.role !== 'supplier') {
      return res.status(404).json({ error: 'Credit entry not found' });
    }

    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    const quote = creditSetupFees.computeQuote(ledger.creditAmount);

    const data = {
      status: 'active',
      productId: mycover.creditLifeProductId(),
      policyNumber: `STUB/${ledger.id.slice(-6).toUpperCase()}`,
      sumInsured: ledger.creditAmount,
      premiumAmount: quote.mycoverPremium,
      expiresAt,
      claimLink: null,
      lastEventId: `sim-${Date.now()}`,
    };

    const policy = ledger.creditLifePolicy
      ? await prisma.creditLifePolicy.update({ where: { id: ledger.creditLifePolicy.id }, data })
      : await prisma.creditLifePolicy.create({
        data: {
          creditLedgerId: ledger.id,
          merchantRef: mycover.newMerchantRef(),
          ...data,
        },
      });

    res.json({
      data: {
        covering: true,
        stub: true,
        policy: mycover.toPublicPolicy(policy, ledger.creditAmount),
        setupQuote: buildSetupQuote(ledger),
        purchaseAllowed: true,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to simulate Credit Life cover' });
  }
});

module.exports = router;
