'use strict';

/**
 * API routes — the full contract from PACKAGING-PLAN.md.
 *
 * Auth = Bearer token, 30-day sessions (see auth.js). All errors are
 * { "error": "plain message" } with the right HTTP status.
 *
 *   POST /api/auth/signup          {email, password}
 *   POST /api/auth/signin-parent   {email, password}
 *   POST /api/auth/signin-kid      {email, kidId, pictureCode: [g, g, g]}
 *                                    (kidId = cached kid id, or first name on
 *                                    a fresh device — resolved case-insensitively)
 *   POST /api/auth/signout
 *   GET  /api/state
 *   POST /api/kids                (parent; trial/free plan: 1 kid max)
 *   DELETE /api/kids/:id          (parent)
 *   POST /api/kids/:id/picture-code
 *   POST /api/kids/:id/pet
 *   POST /api/kids/:id/pet-accessory
 *   POST /api/chores              (parent)
 *   PATCH /api/chores/:id         (parent)
 *   DELETE /api/chores/:id        (parent)
 *   POST /api/chores/:id/start    (kid)
 *   POST /api/chores/:id/done     (kid)
 *   POST /api/chores/:id/approve  (parent; first approval: pet +1 XP, once)
 *   POST /api/chores/:id/reject   (parent)
 *   POST /api/chores/:id/steps/:index/toggle (kid)
 *   POST /api/chores/:id/claim-prize (kid, only after approval)
 *   GET  /api/prizes
 *   PATCH /api/prizes/:id         (parent)
 *   POST /api/prizes/reset        (parent)
 *   POST /api/payouts/mark-paid   (parent; idempotent per kid/week)
 *   PATCH /api/payouts/:id        (parent)
 *   DELETE /api/payouts/:id       (parent)
 *   POST /api/pin/set             (parent; changing needs the current PIN)
 *   POST /api/pin/verify          (any signed-in session — the kid-side PIN pad)
 *   POST /api/display-modes
 *   GET  /api/billing/products
 *   POST /api/billing/verify      (parent; 503 when Play is not configured)
 */
const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
const billing = require('./billing');
const util = require('./util');

const router = express.Router();

// --- small helpers ------------------------------------------------------------
function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function notFound(res, what) {
  return res.status(404).json({ error: `${what} not found.` });
}

function validPictureCode(code) {
  return (
    Array.isArray(code) &&
    code.length === 3 &&
    code.every((g) => typeof g === 'string' && g.trim().length > 0)
  );
}

function samePictureCode(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((g, i) => g === b[i]);
}

// A kid session may only touch its own kid's chores; a parent may touch any.
function choreBelongsToSession(req, chore) {
  return req.session.role === 'parent' || chore.kid_id === req.session.kidId;
}

function publicFamily(family) {
  return { id: family.id, email: family.email };
}

// --- auth ---------------------------------------------------------------------
router.post('/auth/signup', (req, res) => {
  const { email, password } = req.body || {};
  if (!util.isValidEmail(email)) return badRequest(res, 'Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 6) {
    return badRequest(res, 'Choose a password of at least 6 characters.');
  }
  const cleanEmail = email.trim().toLowerCase();
  if (db.getFamilyByEmail(cleanEmail)) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }
  const family = db.createFamily({ email: cleanEmail, passwordHash: auth.hashPassword(password) });
  const session = db.createSession({ familyId: family.id, role: 'parent' });
  return res.status(201).json({ token: session.token, family: publicFamily(family) });
});

router.post('/auth/signin-parent', (req, res) => {
  const { email, password } = req.body || {};
  if (!util.isValidEmail(email) || typeof password !== 'string') {
    return badRequest(res, 'Enter your email and password.');
  }
  const family = db.getFamilyByEmail(email.trim().toLowerCase());
  if (!family || !auth.verifyPassword(password, family.password_hash)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  const session = db.createSession({ familyId: family.id, role: 'parent' });
  return res.json({ token: session.token, family: publicFamily(family) });
});

router.post('/auth/signin-kid', (req, res) => {
  const { email, kidId, pictureCode } = req.body || {};
  if (!util.isValidEmail(email) || typeof kidId !== 'string' || !validPictureCode(pictureCode)) {
    return badRequest(res, 'Enter the parent email, your name, and your 3-picture code.');
  }
  const family = db.getFamilyByEmail(email.trim().toLowerCase());
  if (!family) return res.status(401).json({ error: 'That picture code does not match.' });
  // kidId is the cached kid id when this device has seen the family before,
  // otherwise the typed first name on a fresh device — resolve a name
  // (case-insensitive) to the kid.
  let kid = db.getKidById(family.id, kidId);
  if (!kid) {
    const matches = db.getKidsByName(family.id, kidId);
    if (matches.length === 1) {
      kid = matches[0];
    } else if (matches.length > 1) {
      return res
        .status(401)
        .json({ error: 'More than one child has that name. Ask a parent to pick your name on this device.' });
    }
  }
  if (!kid) return res.status(401).json({ error: 'That picture code does not match.' });
  let storedCode = null;
  try {
    storedCode = kid.picture_code ? JSON.parse(kid.picture_code) : null;
  } catch {
    storedCode = null;
  }
  if (!storedCode) {
    return badRequest(res, 'Ask a parent to set a picture code for you first.');
  }
  if (!samePictureCode(storedCode, pictureCode)) {
    return res.status(401).json({ error: 'That picture code does not match.' });
  }
  const session = db.createSession({ familyId: family.id, role: 'kid', kidId: kid.id });
  return res.json({ token: session.token, kid: db.publicKid(kid) });
});

router.post('/auth/signout', auth.requireAuth, (req, res) => {
  const header = req.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) db.deleteSessionByToken(match[1].trim());
  return res.json({ ok: true });
});

// --- state --------------------------------------------------------------------
router.get('/state', auth.requireAuth, (req, res) => {
  return res.json(db.buildFamilyState(req.session.familyId, req.session));
});

// --- kids ---------------------------------------------------------------------
router.post('/kids', auth.requireAuth, auth.requireParent, (req, res) => {
  const { name, avatar, color, pictureCode } = req.body || {};
  if (!util.isNonEmptyString(name, 100)) return badRequest(res, 'Enter a name for the child.');
  if (pictureCode !== undefined && pictureCode !== null && !validPictureCode(pictureCode)) {
    return badRequest(res, 'A picture code is 3 pictures.');
  }
  const family = db.getFamilyById(req.session.familyId);
  // Trial and free plans allow 1 child; Pro is unlimited.
  if (family.plan !== 'pro' && db.countKids(family.id) >= 1) {
    return res
      .status(403)
      .json({ error: 'Your plan allows 1 child. Upgrade to Pro to add more children.' });
  }
  const kid = db.createKid({
    familyId: family.id,
    name: name.trim(),
    avatar: typeof avatar === 'string' ? avatar : null,
    color: typeof color === 'string' ? color : null,
    pictureCode: pictureCode || null,
  });
  return res.status(201).json(db.publicKid(kid));
});

router.delete('/kids/:id', auth.requireAuth, auth.requireParent, (req, res) => {
  const kid = db.getKidById(req.session.familyId, req.params.id);
  if (!kid) return notFound(res, 'Child');
  db.deleteKid(req.session.familyId, kid.id);
  return res.json({ ok: true });
});

router.post('/kids/:id/picture-code', auth.requireAuth, auth.requireParent, (req, res) => {
  const { code } = req.body || {};
  if (!validPictureCode(code)) return badRequest(res, 'A picture code is 3 pictures.');
  const kid = db.getKidById(req.session.familyId, req.params.id);
  if (!kid) return notFound(res, 'Child');
  const updated = db.updateKid(req.session.familyId, kid.id, { picture_code: JSON.stringify(code) });
  return res.json(db.publicKid(updated));
});

router.post('/kids/:id/pet', auth.requireAuth, auth.kidScope, (req, res) => {
  const { pet } = req.body || {};
  if (!util.PETS.includes(pet)) {
    return badRequest(res, `Choose a pet: ${util.PETS.join(', ')}.`);
  }
  const kid = db.getKidById(req.session.familyId, req.params.id);
  if (!kid) return notFound(res, 'Child');
  // Swapping pets keeps XP and the accessory.
  const updated = db.updateKid(req.session.familyId, kid.id, { pet });
  return res.json(db.publicKid(updated));
});

router.post('/kids/:id/pet-accessory', auth.requireAuth, auth.kidScope, (req, res) => {
  const { accessory } = req.body || {};
  const allowed = ['hat', 'bow', 'star', null];
  if (!allowed.includes(accessory)) {
    return badRequest(res, 'Choose an accessory: hat, bow, star, or none.');
  }
  const kid = db.getKidById(req.session.familyId, req.params.id);
  if (!kid) return notFound(res, 'Child');
  if (accessory !== null && !util.unlockedAccessories(kid.pet_xp || 0).includes(accessory)) {
    const need = util.ACCESSORY_UNLOCK_XP[accessory];
    return res
      .status(403)
      .json({ error: `That accessory unlocks at ${need} pet stars. Keep finishing chores!` });
  }
  const updated = db.updateKid(req.session.familyId, kid.id, { pet_accessory: accessory });
  return res.json(db.publicKid(updated));
});

// --- chores -------------------------------------------------------------------
router.post('/chores', auth.requireAuth, auth.requireParent, (req, res) => {
  const { kidId, name, valueCents, date, steps, repeatWeekly } = req.body || {};
  if (typeof kidId !== 'string' || !db.getKidById(req.session.familyId, kidId)) {
    return badRequest(res, 'Choose a child for this chore.');
  }
  if (!util.isNonEmptyString(name, 200)) return badRequest(res, 'Enter a name for the chore.');
  if (!util.isInt(valueCents, 0, 1000000)) {
    return badRequest(res, 'Enter an amount in cents (0 or more).');
  }
  if (!util.isValidDateString(date)) return badRequest(res, 'Enter a date like 2026-11-17.');
  const cleanSteps = util.normaliseSteps(steps);
  if (cleanSteps === null) return badRequest(res, 'Steps must be a list of short phrases.');
  const chore = db.createChore({
    familyId: req.session.familyId,
    kidId,
    name: name.trim(),
    valueCents,
    date,
    steps: cleanSteps,
    repeatWeekly: repeatWeekly === true,
  });
  return res.status(201).json(db.publicChore(chore));
});

router.patch('/chores/:id', auth.requireAuth, auth.requireParent, (req, res) => {
  const chore = db.getChoreById(req.session.familyId, req.params.id);
  if (!chore) return notFound(res, 'Chore');
  const { name, valueCents, steps, repeatWeekly } = req.body || {};
  const fields = {};
  if (name !== undefined) {
    if (!util.isNonEmptyString(name, 200)) return badRequest(res, 'Enter a name for the chore.');
    fields.name = name.trim();
  }
  if (valueCents !== undefined) {
    if (!util.isInt(valueCents, 0, 1000000)) {
      return badRequest(res, 'Enter an amount in cents (0 or more).');
    }
    fields.value_cents = valueCents;
  }
  if (steps !== undefined) {
    const cleanSteps = util.normaliseSteps(steps);
    if (cleanSteps === null) return badRequest(res, 'Steps must be a list of short phrases.');
    fields.steps = JSON.stringify(cleanSteps);
  }
  // The repeat-weekly toggle applies to the whole series, not one copy.
  if (repeatWeekly !== undefined) {
    if (typeof repeatWeekly !== 'boolean') return badRequest(res, 'repeatWeekly must be true or false.');
    let group = chore.repeat_group;
    if (repeatWeekly && !group) {
      group = crypto.randomUUID();
      fields.repeat_group = group;
    }
    fields.repeat_weekly = repeatWeekly ? 1 : 0;
    if (group) {
      db.db
        .prepare('UPDATE chores SET repeat_weekly = ? WHERE family_id = ? AND repeat_group = ?')
        .run(repeatWeekly ? 1 : 0, req.session.familyId, group);
    }
  }
  const updated = db.updateChore(req.session.familyId, chore.id, fields);
  if (repeatWeekly === true) db.ensureRepeatCarryOver(req.session.familyId);
  return res.json(db.publicChore(updated));
});

router.delete('/chores/:id', auth.requireAuth, auth.requireParent, (req, res) => {
  const chore = db.getChoreById(req.session.familyId, req.params.id);
  if (!chore) return notFound(res, 'Chore');
  db.deleteChore(req.session.familyId, chore.id);
  return res.json({ ok: true });
});

router.post('/chores/:id/start', auth.requireAuth, (req, res) => {
  const chore = db.getChoreById(req.session.familyId, req.params.id);
  if (!chore) return notFound(res, 'Chore');
  if (!choreBelongsToSession(req, chore)) {
    return res.status(403).json({ error: 'That chore belongs to another child.' });
  }
  if (chore.status !== 'todo') return badRequest(res, 'This chore has already been started.');
  // Starting earns a Starter Star (recorded; no prize yet).
  const updated = db.updateChore(req.session.familyId, chore.id, {
    starter_star: 1,
    started_at: new Date().toISOString(),
  });
  return res.json(db.publicChore(updated));
});

router.post('/chores/:id/done', auth.requireAuth, (req, res) => {
  const chore = db.getChoreById(req.session.familyId, req.params.id);
  if (!chore) return notFound(res, 'Chore');
  if (!choreBelongsToSession(req, chore)) {
    return res.status(403).json({ error: 'That chore belongs to another child.' });
  }
  if (chore.status === 'pending') return res.json(db.publicChore(chore)); // already waiting
  if (chore.status !== 'todo') return badRequest(res, 'This chore is not waiting to be done.');
  const updated = db.updateChore(req.session.familyId, chore.id, { status: 'pending' });
  return res.json(db.publicChore(updated));
});

router.post('/chores/:id/approve', auth.requireAuth, auth.requireParent, (req, res) => {
  const chore = db.getChoreById(req.session.familyId, req.params.id);
  if (!chore) return notFound(res, 'Chore');
  if (chore.status === 'approved' || chore.status === 'complete') {
    return res.json(db.publicChore(chore)); // already approved — no second XP
  }
  if (chore.status !== 'pending') {
    return badRequest(res, 'Only a finished chore can be approved.');
  }
  // First approval of this chore gives the kid's pet +1 XP, exactly once.
  if (!chore.pet_xp_awarded) {
    const kid = db.getKidById(req.session.familyId, chore.kid_id);
    if (kid) db.updateKid(req.session.familyId, kid.id, { pet_xp: (kid.pet_xp || 0) + 1 });
  }
  const updated = db.updateChore(req.session.familyId, chore.id, {
    status: 'approved',
    pet_xp_awarded: 1,
  });
  return res.json(db.publicChore(updated));
});

router.post('/chores/:id/reject', auth.requireAuth, auth.requireParent, (req, res) => {
  const chore = db.getChoreById(req.session.familyId, req.params.id);
  if (!chore) return notFound(res, 'Chore');
  if (chore.status === 'todo') return res.json(db.publicChore(chore));
  if (chore.status !== 'pending') {
    return badRequest(res, 'Only a chore waiting for approval can be sent back.');
  }
  const updated = db.updateChore(req.session.familyId, chore.id, { status: 'todo' });
  return res.json(db.publicChore(updated));
});

router.post('/chores/:id/steps/:index/toggle', auth.requireAuth, (req, res) => {
  const chore = db.getChoreById(req.session.familyId, req.params.id);
  if (!chore) return notFound(res, 'Chore');
  if (!choreBelongsToSession(req, chore)) {
    return res.status(403).json({ error: 'That chore belongs to another child.' });
  }
  const index = parseInt(req.params.index, 10);
  let steps = [];
  try {
    steps = JSON.parse(chore.steps || '[]');
  } catch {
    steps = [];
  }
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
    return badRequest(res, 'That step does not exist.');
  }
  steps[index].done = !steps[index].done;
  const updated = db.updateChore(req.session.familyId, chore.id, { steps: JSON.stringify(steps) });
  return res.json(db.publicChore(updated));
});

router.post('/chores/:id/claim-prize', auth.requireAuth, (req, res) => {
  const chore = db.getChoreById(req.session.familyId, req.params.id);
  if (!chore) return notFound(res, 'Chore');
  if (!choreBelongsToSession(req, chore)) {
    return res.status(403).json({ error: 'That chore belongs to another child.' });
  }
  if (chore.status === 'complete') return badRequest(res, 'This chore already has its prize.');
  if (chore.status !== 'approved') {
    return badRequest(res, 'A parent has to approve this chore before you can win a prize.');
  }
  const { prizeId } = req.body || {};
  if (!prizeId) return badRequest(res, 'Choose one of the prizes.');
  const prize = db.getPrizeById(req.session.familyId, prizeId);
  if (!prize) return badRequest(res, 'Choose one of the prizes.');
  // Won prizes keep the name they were won with, even if a parent renames
  // the prize later.
  const win = db.createPrizeWin({
    familyId: req.session.familyId,
    kidId: chore.kid_id,
    choreId: chore.id,
    prizeId: prize.id,
    prizeNameAtWin: prize.name,
  });
  db.updateChore(req.session.familyId, chore.id, { status: 'complete' });
  return res.status(201).json({
    chore: db.publicChore(db.getChoreById(req.session.familyId, chore.id)),
    prizeWin: db.publicPrizeWin(win),
  });
});

// --- prizes -------------------------------------------------------------------
router.get('/prizes', auth.requireAuth, (req, res) => {
  return res.json(db.getPrizesByFamily(req.session.familyId).map(db.publicPrize));
});

router.patch('/prizes/:id', auth.requireAuth, auth.requireParent, (req, res) => {
  const prize = db.getPrizeById(req.session.familyId, req.params.id);
  if (!prize) return notFound(res, 'Prize');
  const { name, shortLabel, icon, color } = req.body || {};
  const fields = {};
  if (name !== undefined) {
    if (!util.isNonEmptyString(name, 100)) return badRequest(res, 'Enter a prize name.');
    fields.name = name.trim();
  }
  if (shortLabel !== undefined) {
    if (!util.isNonEmptyString(shortLabel, 30)) return badRequest(res, 'Enter a short label.');
    fields.short_label = shortLabel.trim();
  }
  if (icon !== undefined) {
    if (!util.isNonEmptyString(icon, 10)) return badRequest(res, 'Choose an icon.');
    fields.icon = icon.trim();
  }
  if (color !== undefined) {
    if (!util.isNonEmptyString(color, 20)) return badRequest(res, 'Choose a colour.');
    fields.color = color.trim();
  }
  const updated = db.updatePrize(req.session.familyId, prize.id, fields);
  return res.json(db.publicPrize(updated));
});

router.post('/prizes/reset', auth.requireAuth, auth.requireParent, (req, res) => {
  const prizes = db.resetPrizes(req.session.familyId);
  return res.json(prizes.map(db.publicPrize));
});

// --- payouts ------------------------------------------------------------------
router.post('/payouts/mark-paid', auth.requireAuth, auth.requireParent, (req, res) => {
  const { kidId, weekStart, amountCents } = req.body || {};
  if (typeof kidId !== 'string' || !db.getKidById(req.session.familyId, kidId)) {
    return badRequest(res, 'Choose a child for this payout.');
  }
  if (!util.isValidDateString(weekStart)) {
    return badRequest(res, 'Enter a week start date like 2026-11-16.');
  }
  if (!util.isInt(amountCents, 0, 100000000)) {
    return badRequest(res, 'Enter an amount in cents (0 or more).');
  }
  // Weeks are Monday–Sunday; any day in the week maps to its Monday.
  const monday = util.mondayOf(weekStart);
  // Idempotent: same kid/week returns the existing record, never a duplicate.
  const existing = db.getPayoutByKidWeek(req.session.familyId, kidId, monday);
  if (existing) {
    return res.json({ ...db.publicPayout(existing), existing: true });
  }
  const payout = db.createPayout({
    familyId: req.session.familyId,
    kidId,
    weekStart: monday,
    amountCents,
  });
  return res.status(201).json(db.publicPayout(payout));
});

router.patch('/payouts/:id', auth.requireAuth, auth.requireParent, (req, res) => {
  const payout = db.getPayoutById(req.session.familyId, req.params.id);
  if (!payout) return notFound(res, 'Payout');
  const { amountCents } = req.body || {};
  if (!util.isInt(amountCents, 0, 100000000)) {
    return badRequest(res, 'Enter an amount in cents (0 or more).');
  }
  const updated = db.updatePayout(req.session.familyId, payout.id, amountCents);
  return res.json(db.publicPayout(updated));
});

router.delete('/payouts/:id', auth.requireAuth, auth.requireParent, (req, res) => {
  const payout = db.getPayoutById(req.session.familyId, req.params.id);
  if (!payout) return notFound(res, 'Payout');
  db.deletePayout(req.session.familyId, payout.id);
  return res.json({ ok: true });
});

// --- PIN ----------------------------------------------------------------------
router.post('/pin/set', auth.requireAuth, auth.requireParent, (req, res) => {
  const { pin, currentPin } = req.body || {};
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return badRequest(res, 'A PIN is 4 digits.');
  }
  const family = db.getFamilyById(req.session.familyId);
  if (family.pin_hash) {
    // Changing a PIN requires the current one.
    if (typeof currentPin !== 'string' || !auth.verifyPin(currentPin, family.pin_hash)) {
      return res.status(403).json({ error: 'Current PIN is incorrect.' });
    }
  }
  db.updateFamily(family.id, { pin_hash: auth.hashPin(pin) });
  return res.json({ ok: true, hasPin: true });
});

router.post('/pin/verify', auth.requireAuth, (req, res) => {
  const { pin } = req.body || {};
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return badRequest(res, 'A PIN is 4 digits.');
  }
  const family = db.getFamilyById(req.session.familyId);
  if (!family.pin_hash) return res.json({ ok: false, hasPin: false });
  return res.json({ ok: auth.verifyPin(pin, family.pin_hash), hasPin: true });
});

// --- display modes ------------------------------------------------------------
router.post('/display-modes', auth.requireAuth, (req, res) => {
  const { calmMode, focusMode } = req.body || {};
  if (calmMode !== undefined && typeof calmMode !== 'boolean') {
    return badRequest(res, 'calmMode must be true or false.');
  }
  if (focusMode !== undefined && typeof focusMode !== 'boolean') {
    return badRequest(res, 'focusMode must be true or false.');
  }
  // A kid may toggle calm mode without a PIN; focus mode is parent-only.
  if (req.session.role === 'kid' && focusMode !== undefined) {
    return res.status(403).json({ error: 'Only a parent can change focus mode.' });
  }
  const fields = {};
  if (calmMode !== undefined) fields.calm_mode = calmMode ? 1 : 0;
  if (focusMode !== undefined) fields.focus_mode = focusMode ? 1 : 0;
  const family = db.updateFamily(req.session.familyId, fields);
  return res.json({
    displayModes: { calmMode: family.calm_mode === 1, focusMode: family.focus_mode === 1 },
  });
});

// --- billing ------------------------------------------------------------------
router.get('/billing/products', (req, res) => {
  return res.json(billing.PRODUCTS);
});

router.post('/billing/verify', auth.requireAuth, auth.requireParent, async (req, res) => {
  const { productId, purchaseToken } = req.body || {};
  const product = billing.getProduct(productId);
  if (!product) return badRequest(res, 'Unknown product.');
  if (typeof purchaseToken !== 'string' || !purchaseToken.trim()) {
    return badRequest(res, 'A purchase token is required.');
  }
  if (!billing.isConfigured()) {
    // Never invent a verification.
    return res.status(503).json({ error: 'billing verification not configured' });
  }
  let result;
  try {
    result = await billing.verifySubscription(productId, purchaseToken.trim());
  } catch (err) {
    if (err instanceof billing.BillingError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[billing] unexpected error:', err);
    return res.status(502).json({ error: 'Could not verify the purchase with Google Play.' });
  }
  if (!result.active) {
    return res.status(400).json({ error: 'This subscription is not active.' });
  }
  if (!result.productIds.includes(productId)) {
    return res.status(400).json({ error: 'This purchase is for a different product.' });
  }
  const previous = db.getPurchaseByToken(purchaseToken.trim());
  if (previous && previous.family_id !== req.session.familyId) {
    return res.status(409).json({ error: 'This purchase is already linked to another family.' });
  }
  db.upsertPurchase({
    familyId: req.session.familyId,
    productId,
    purchaseToken: purchaseToken.trim(),
    state: result.state,
  });
  const plan = result.inTrial ? 'trial' : 'pro';
  const family = db.updateFamily(req.session.familyId, {
    plan,
    plan_period: product.period,
  });
  return res.json({ plan: family.plan, planPeriod: family.plan_period });
});

module.exports = router;
