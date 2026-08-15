const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_ROLES = new Set(['trader', 'supplier']);

router.post('/', async (req, res) => {
  try {
    const emailRaw = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
    const roleRaw = typeof req.body?.role === 'string' ? req.body.role.trim().toLowerCase() : '';

    if (!emailRaw || !EMAIL_RE.test(emailRaw)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }

    const role = ALLOWED_ROLES.has(roleRaw) ? roleRaw : null;

    await prisma.waitlistEntry.upsert({
      where: { email: emailRaw },
      create: {
        email: emailRaw,
        name: name || null,
        role,
      },
      update: {
        ...(name ? { name } : {}),
        ...(role ? { role } : {}),
      },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('Waitlist error:', err);
    return res.status(500).json({ error: 'Failed to join waitlist' });
  }
});

module.exports = router;
