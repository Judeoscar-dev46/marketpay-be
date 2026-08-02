const express = require('express');
const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { maskAccountNumber } = require('../services/supplierInvites');

const router = express.Router();

function formatNaira(kobo) {
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// GET /api/credit-agreement/ledger/:ledgerId — in-app snapshot history, trader or supplier of that ledger only
router.get('/ledger/:ledgerId', requireAuth, async (req, res) => {
  try {
    const ledger = await prisma.creditLedger.findUnique({
      where: { id: req.params.ledgerId },
      include: { supplier: true },
    });
    if (!ledger) return res.status(404).json({ error: 'Credit entry not found' });

    const isTrader = ledger.supplier.traderId === req.auth.id;
    const isSupplier = ledger.supplier.supplierUserId === req.auth.id;
    if (!isTrader && !isSupplier) return res.status(404).json({ error: 'Credit entry not found' });

    const snapshots = await prisma.creditAgreementSnapshot.findMany({
      where: { creditLedgerId: ledger.id },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      data: snapshots.map((s) => ({
        ...s,
        shareUrl: `/api/credit-agreement/${s.shareToken}/html`,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch agreement history' });
  }
});

// GET /api/credit-agreement/:shareToken — public, unauthenticated JSON
router.get('/:shareToken', async (req, res) => {
  try {
    const snapshot = await prisma.creditAgreementSnapshot.findUnique({ where: { shareToken: req.params.shareToken } });
    if (!snapshot) return res.status(404).json({ error: 'Agreement not found' });

    res.json({
      data: {
        creditAmount: snapshot.creditAmount,
        outstandingBalance: snapshot.outstandingBalance,
        terms: snapshot.terms,
        note: snapshot.note,
        traderName: snapshot.traderName,
        traderBusiness: snapshot.traderBusiness,
        supplierName: snapshot.supplierName,
        supplierBankName: snapshot.supplierBankName,
        supplierAccountNumber: maskAccountNumber(snapshot.supplierAccountNumber),
        agreedAt: snapshot.agreedAt,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch agreement' });
  }
});

// GET /api/credit-agreement/:shareToken/html — public, unauthenticated, printable summary page
router.get('/:shareToken/html', async (req, res) => {
  try {
    const snapshot = await prisma.creditAgreementSnapshot.findUnique({ where: { shareToken: req.params.shareToken } });
    if (!snapshot) return res.status(404).send('<p>Agreement not found.</p>');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Credit Agreement Summary</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 20px; border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; }
  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e5e5; }
  .label { color: #666; }
  .value { font-weight: 600; text-align: right; }
  .terms, .note { white-space: pre-wrap; padding: 10px 0; }
  .disclaimer { margin-top: 32px; font-size: 12px; color: #666; border-top: 1px solid #e5e5e5; padding-top: 16px; }
  button { margin-top: 24px; padding: 8px 16px; font-size: 14px; cursor: pointer; }
  @media print { button { display: none; } }
</style>
</head>
<body>
  <h1>Credit Agreement Summary</h1>
  <div class="row"><span class="label">Trader</span><span class="value">${escapeHtml(snapshot.traderName)} (${escapeHtml(snapshot.traderBusiness)})</span></div>
  <div class="row"><span class="label">Supplier</span><span class="value">${escapeHtml(snapshot.supplierName)}</span></div>
  <div class="row"><span class="label">Credit amount</span><span class="value">${formatNaira(snapshot.creditAmount)}</span></div>
  <div class="row"><span class="label">Outstanding balance</span><span class="value">${formatNaira(snapshot.outstandingBalance)}</span></div>
  <div class="row"><span class="label">Agreed on</span><span class="value">${new Date(snapshot.agreedAt).toLocaleString('en-NG')}</span></div>
  ${snapshot.terms ? `<div class="row"><span class="label">Terms</span></div><div class="terms">${escapeHtml(snapshot.terms)}</div>` : ''}
  ${snapshot.note ? `<div class="row"><span class="label">Note</span></div><div class="note">${escapeHtml(snapshot.note)}</div>` : ''}
  <p class="disclaimer">This is a record of credit terms agreed via MarketPay between the parties named above. MarketPay is not a party to and does not enforce this agreement.</p>
  <button onclick="window.print()">Print / Save as PDF</button>
</body>
</html>`;
    res.set('Content-Type', 'text/html').send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('<p>Failed to load agreement.</p>');
  }
});

module.exports = router;
