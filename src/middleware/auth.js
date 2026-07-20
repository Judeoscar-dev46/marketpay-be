const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
const EXPIRES_IN = '7d';

function issueSession({ id, role }) {
  return jwt.sign({ id, role }, SECRET, { expiresIn: EXPIRES_IN });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    req.auth = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireTrader(req, res, next) {
  if (req.auth?.role !== 'trader') return res.status(403).json({ error: 'Trader account required' });
  next();
}

function requireSupplier(req, res, next) {
  if (req.auth?.role !== 'supplier') return res.status(403).json({ error: 'Supplier account required' });
  next();
}

module.exports = { issueSession, requireAuth, requireTrader, requireSupplier };
