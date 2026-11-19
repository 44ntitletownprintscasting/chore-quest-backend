'use strict';

/**
 * Chore Quest backend — entry point.
 *
 * Node + Express + SQLite (node:sqlite). No ads, no analytics, no location,
 * no AD_ID anywhere. The weekly payout is cash outside the app; this server
 * never holds or moves money.
 *
 * Routes:
 *   GET  /health                     health check (no auth)
 *   POST /api/auth/signup            create a family account (parent)
 *   POST /api/auth/signin-parent     parent sign-in
 *   POST /api/auth/signin-kid        kid sign-in (parent email + name + 3-picture code)
 *   POST /api/auth/signout
 *   GET  /api/state                  full signed-in family state + money summary
 *   POST /api/kids ...               kids, picture codes, pets, accessories
 *   POST /api/chores ...             chores, start/done/approve/reject, steps, prizes
 *   GET  /api/prizes ...             the family's 8 game prizes
 *   POST /api/payouts ...            mark-paid (idempotent), edit, delete
 *   POST /api/pin/set|verify         4-digit parent PIN (hashed, never returned)
 *   POST /api/display-modes          calm mode / focus mode
 *   GET  /api/billing/products       the two Play subscription products
 *   POST /api/billing/verify         server-side Play purchase verification
 *
 * Config comes from the environment only (see src/config.js). The server
 * fails fast with a plain message if PORT is missing.
 */
const express = require('express');
const cors = require('cors');
const config = require('./config');

const app = express();
app.set('trust proxy', true); // correct client IPs behind Fly.io's proxy

// CORS: the client is a Capacitor app (capacitor://localhost, or the web
// client on its own origin), so origins cannot be allow-listed in advance.
// Auth is Bearer-token based — there are no cookies to steal — so any
// origin may call the API; a request without a valid token still gets 401.
app.use(cors());

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'chore-quest-backend',
    version: '1.0.0',
    billing_configured: config.billingConfigured,
  });
});

app.use(express.json({ limit: '256kb' }));

// --- tiny in-memory rate limiter ----------------------------------------------
function rateLimit({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    next();
  };
}

// Brute-force protection on sign-ins and PIN checks.
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });
app.use('/api/auth/signin-parent', authLimiter);
app.use('/api/auth/signin-kid', authLimiter);
app.use('/api/pin/verify', authLimiter);

// General API limit.
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300 }));

app.use('/api', require('./routes'));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Central error handler. Never leaks secrets or stack traces.
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON.' });
  }
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('[server] unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error.' });
});

app.listen(config.port, () => {
  console.log(`[server] chore-quest-backend listening on port ${config.port}`);
  console.log(`[server] db=${config.databasePath} billing_configured=${config.billingConfigured}`);
  if (!config.billingConfigured) {
    console.log('[server] Play billing NOT configured — POST /api/billing/verify will answer 503.');
  }
});
