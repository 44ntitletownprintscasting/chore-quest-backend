'use strict';

/**
 * Auth helpers — PBKDF2 password/PIN hashing (salted, never reversible),
 * Bearer-token sessions, and the middleware that enforces them.
 *
 * Hash format: pbkdf2$<iterations>$<salt hex>$<hash hex>
 * PINs are hashed exactly like passwords; a PIN is never returned.
 */
const crypto = require('crypto');
const db = require('./db');

const ITERATIONS = 100000;
const KEY_LEN = 32;
const DIGEST = 'sha256';

function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(secret, salt, ITERATIONS, KEY_LEN, DIGEST).toString('hex');
  return `pbkdf2$${ITERATIONS}$${salt}$${hash}`;
}

function verifySecret(secret, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = parts[2];
  const expected = parts[3];
  if (!Number.isFinite(iterations) || !salt || !expected) return false;
  const hash = crypto.pbkdf2Sync(secret, salt, iterations, KEY_LEN, DIGEST).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashPassword(password) {
  return hashSecret(password);
}

function verifyPassword(password, stored) {
  return verifySecret(password, stored);
}

function hashPin(pin) {
  return hashSecret(pin);
}

function verifyPin(pin, stored) {
  return verifySecret(pin, stored);
}

// --- middleware ---------------------------------------------------------------
// Attaches req.session {id, familyId, role, kidId} or answers 401.
function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Sign in to continue.' });
  }
  const session = db.getSessionByToken(match[1].trim());
  if (!session) {
    return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
  req.session = {
    id: session.id,
    familyId: session.family_id,
    role: session.role,
    kidId: session.kid_id,
  };
  next();
}

// Parent-only endpoints (family account actions, payouts, billing).
function requireParent(req, res, next) {
  if (req.session.role !== 'parent') {
    return res.status(403).json({ error: 'Only a parent can do that.' });
  }
  next();
}

// Kid endpoints: a kid session may only act on its own kid; a parent may
// act on any kid in the family.
function kidScope(req, res, next) {
  if (req.session.role === 'kid' && req.session.kidId !== req.params.id) {
    return res.status(403).json({ error: 'You can only change your own things.' });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  hashPin,
  verifyPin,
  requireAuth,
  requireParent,
  kidScope,
};
