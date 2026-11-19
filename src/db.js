'use strict';

/**
 * Persistence — a single SQLite file (Node's built-in node:sqlite, no
 * native dependencies). Tables mirror the PACKAGING-PLAN data model, plus
 * two small extras the plan's behaviour needs:
 *
 *   chores.starter_star   1 once the kid has started the chore (the Starter
 *                         Star is recorded; it is not a prize).
 *   chores.repeat_group   id shared by every copy of a repeat-weekly series,
 *                         so carry-over can stay idempotent (one copy per
 *                         week, never duplicates).
 *
 * Business rules enforced here / in routes:
 *   - first approval of a chore gives the kid's pet +1 XP exactly once
 *     (chores.pet_xp_awarded).
 *   - repeat-weekly chores carry into each new week (same steps/amount/
 *     weekday) until turned off; carry-over is idempotent.
 *   - won prizes keep the name they were won with
 *     (prize_wins.prize_name_at_win).
 *   - earned = approved + played (claimed) chores; balance = earned - paid.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const util = require('./util');

const dbPath = path.resolve(config.databasePath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS families (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free',
    plan_period TEXT,
    pin_hash TEXT,
    calm_mode INTEGER NOT NULL DEFAULT 0,
    focus_mode INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    role TEXT NOT NULL,
    kid_id TEXT,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token);

  CREATE TABLE IF NOT EXISTS kids (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    color TEXT,
    picture_code TEXT,
    pet TEXT,
    pet_xp INTEGER NOT NULL DEFAULT 0,
    pet_accessory TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kids_family ON kids (family_id);

  CREATE TABLE IF NOT EXISTS chores (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    kid_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value_cents INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    steps TEXT NOT NULL DEFAULT '[]',
    repeat_weekly INTEGER NOT NULL DEFAULT 0,
    repeat_group TEXT,
    pet_xp_awarded INTEGER NOT NULL DEFAULT 0,
    starter_star INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chores_family ON chores (family_id);
  CREATE INDEX IF NOT EXISTS idx_chores_kid_date ON chores (kid_id, date);

  CREATE TABLE IF NOT EXISTS prizes (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    name TEXT NOT NULL,
    short_label TEXT NOT NULL,
    icon TEXT NOT NULL,
    color TEXT NOT NULL,
    UNIQUE (family_id, slot)
  );

  CREATE TABLE IF NOT EXISTS prize_wins (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    kid_id TEXT NOT NULL,
    chore_id TEXT NOT NULL,
    prize_id TEXT,
    prize_name_at_win TEXT NOT NULL,
    won_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wins_family ON prize_wins (family_id);

  CREATE TABLE IF NOT EXISTS payouts (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    kid_id TEXT NOT NULL,
    week_start TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    paid_at TEXT NOT NULL,
    UNIQUE (family_id, kid_id, week_start)
  );
  CREATE INDEX IF NOT EXISTS idx_payouts_family ON payouts (family_id);

  CREATE TABLE IF NOT EXISTS purchases (
    id TEXT PRIMARY KEY,
    family_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    purchase_token TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    verified_at TEXT NOT NULL
  );
`);

const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

// --- families -----------------------------------------------------------------
function getFamilyById(id) {
  return db.prepare('SELECT * FROM families WHERE id = ?').get(id) || null;
}

function getFamilyByEmail(email) {
  return db.prepare('SELECT * FROM families WHERE lower(email) = lower(?)').get(email) || null;
}

function createFamily({ email, passwordHash }) {
  const id = newId();
  const now = nowIso();
  db.prepare(
    'INSERT INTO families (id, email, password_hash, plan, plan_period, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, email, passwordHash, 'free', null, now);
  seedPrizes(id);
  return getFamilyById(id);
}

function updateFamily(id, fields) {
  const allowed = ['plan', 'plan_period', 'pin_hash', 'calm_mode', 'focus_mode', 'password_hash'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return getFamilyById(id);
  values.push(id);
  db.prepare(`UPDATE families SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getFamilyById(id);
}

// --- sessions -----------------------------------------------------------------
function createSession({ familyId, role, kidId }) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  db.prepare(
    'INSERT INTO sessions (id, family_id, role, kid_id, token, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(newId(), familyId, role, kidId || null, token, expiresAt);
  return { token, expiresAt };
}

function getSessionByToken(token) {
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }
  return row;
}

function deleteSessionByToken(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function deleteSessionsForKid(familyId, kidId) {
  db.prepare('DELETE FROM sessions WHERE family_id = ? AND kid_id = ?').run(familyId, kidId);
}

// --- kids ---------------------------------------------------------------------
function getKidById(familyId, kidId) {
  return db.prepare('SELECT * FROM kids WHERE id = ? AND family_id = ?').get(kidId, familyId) || null;
}

// Kids on a fresh device only know their first name, so sign-in resolves a
// name (case-insensitive) to a kid. Returns all matches — the caller decides
// what to do when more than one child shares a name.
function getKidsByName(familyId, name) {
  return db
    .prepare('SELECT * FROM kids WHERE family_id = ? AND lower(name) = lower(?) ORDER BY created_at ASC')
    .all(familyId, name.trim());
}

function getKidsByFamily(familyId) {
  return db.prepare('SELECT * FROM kids WHERE family_id = ? ORDER BY created_at ASC').all(familyId);
}

function countKids(familyId) {
  return db.prepare('SELECT COUNT(*) AS n FROM kids WHERE family_id = ?').get(familyId).n;
}

function createKid({ familyId, name, avatar, color, pictureCode }) {
  const id = newId();
  db.prepare(
    'INSERT INTO kids (id, family_id, name, avatar, color, picture_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, familyId, name, avatar || null, color || null, pictureCode ? JSON.stringify(pictureCode) : null, nowIso());
  return getKidById(familyId, id);
}

function updateKid(familyId, kidId, fields) {
  const allowed = ['name', 'avatar', 'color', 'picture_code', 'pet', 'pet_xp', 'pet_accessory'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return getKidById(familyId, kidId);
  values.push(kidId, familyId);
  db.prepare(`UPDATE kids SET ${sets.join(', ')} WHERE id = ? AND family_id = ?`).run(...values);
  return getKidById(familyId, kidId);
}

function deleteKid(familyId, kidId) {
  // Deletes the kid and all their chores, prize wins and payouts, plus any
  // of their signed-in sessions. One explicit transaction (node:sqlite has
  // no transaction() helper — BEGIN/COMMIT via exec).
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM chores WHERE family_id = ? AND kid_id = ?').run(familyId, kidId);
    db.prepare('DELETE FROM prize_wins WHERE family_id = ? AND kid_id = ?').run(familyId, kidId);
    db.prepare('DELETE FROM payouts WHERE family_id = ? AND kid_id = ?').run(familyId, kidId);
    deleteSessionsForKid(familyId, kidId);
    db.prepare('DELETE FROM kids WHERE id = ? AND family_id = ?').run(kidId, familyId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// --- chores -------------------------------------------------------------------
function getChoreById(familyId, choreId) {
  return db.prepare('SELECT * FROM chores WHERE id = ? AND family_id = ?').get(choreId, familyId) || null;
}

function getChoresByFamily(familyId) {
  return db
    .prepare('SELECT * FROM chores WHERE family_id = ? ORDER BY date ASC, created_at ASC')
    .all(familyId);
}

function createChore({ familyId, kidId, name, valueCents, date, steps, repeatWeekly, repeatGroup }) {
  const id = newId();
  const group = repeatWeekly ? repeatGroup || newId() : null;
  db.prepare(
    'INSERT INTO chores (id, family_id, kid_id, name, value_cents, date, status, steps, repeat_weekly, repeat_group, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id, familyId, kidId, name, valueCents, date, 'todo',
    JSON.stringify(steps || []), repeatWeekly ? 1 : 0, group, nowIso()
  );
  return getChoreById(familyId, id);
}

function updateChore(familyId, choreId, fields) {
  const allowed = ['name', 'value_cents', 'status', 'steps', 'repeat_weekly', 'repeat_group', 'pet_xp_awarded', 'starter_star', 'started_at'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return getChoreById(familyId, choreId);
  values.push(choreId, familyId);
  db.prepare(`UPDATE chores SET ${sets.join(', ')} WHERE id = ? AND family_id = ?`).run(...values);
  return getChoreById(familyId, choreId);
}

function deleteChore(familyId, choreId) {
  db.prepare('DELETE FROM chores WHERE id = ? AND family_id = ?').run(choreId, familyId);
}

/**
 * Repeat-weekly carry-over (idempotent).
 * For every repeat-weekly series in the family, make sure a copy exists for
 * this week, on the same weekday as the series' first chore, with the same
 * steps (all unchecked), amount and kid. A copy is created only when no
 * chore with the same repeat_group exists on that date — so calling this
 * twice (or on every /api/state) can never create a duplicate.
 * Only the current week is filled in; past weeks are never back-filled and
 * future weeks are created when their week arrives.
 */
function ensureRepeatCarryOver(familyId) {
  const weekStart = util.currentWeekStart();
  const groups = db
    .prepare(
      'SELECT DISTINCT repeat_group FROM chores WHERE family_id = ? AND repeat_weekly = 1 AND repeat_group IS NOT NULL'
    )
    .all(familyId);
  for (const { repeat_group: group } of groups) {
    const template = db
      .prepare(
        'SELECT * FROM chores WHERE family_id = ? AND repeat_group = ? ORDER BY date ASC, created_at ASC LIMIT 1'
      )
      .get(familyId, group);
    if (!template) continue;
    // The series starts on the template's date; never create a copy dated
    // before the series began.
    const targetDate = util.formatDate(util.addDays(util.parseDate(weekStart), util.weekdayOffset(template.date)));
    if (targetDate < template.date) continue;
    const existing = db
      .prepare('SELECT 1 FROM chores WHERE family_id = ? AND repeat_group = ? AND date = ?')
      .get(familyId, group, targetDate);
    if (existing) continue;
    const steps = JSON.parse(template.steps || '[]').map((s) => ({ text: s.text, done: false }));
    createChore({
      familyId,
      kidId: template.kid_id,
      name: template.name,
      valueCents: template.value_cents,
      date: targetDate,
      steps,
      repeatWeekly: true,
      repeatGroup: group,
    });
  }
}

// --- prizes -------------------------------------------------------------------
function seedPrizes(familyId) {
  for (const p of util.DEFAULT_PRIZES) {
    db.prepare(
      'INSERT OR IGNORE INTO prizes (id, family_id, slot, name, short_label, icon, color) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(newId(), familyId, p.slot, p.name, p.shortLabel, p.icon, p.color);
  }
}

function getPrizesByFamily(familyId) {
  return db.prepare('SELECT * FROM prizes WHERE family_id = ? ORDER BY slot ASC').all(familyId);
}

function getPrizeById(familyId, prizeId) {
  return db.prepare('SELECT * FROM prizes WHERE id = ? AND family_id = ?').get(prizeId, familyId) || null;
}

function updatePrize(familyId, prizeId, fields) {
  const allowed = ['name', 'short_label', 'icon', 'color'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return getPrizeById(familyId, prizeId);
  values.push(prizeId, familyId);
  db.prepare(`UPDATE prizes SET ${sets.join(', ')} WHERE id = ? AND family_id = ?`).run(...values);
  return getPrizeById(familyId, prizeId);
}

function resetPrizes(familyId) {
  // Won prizes keep the name they were won with (prize_wins rows are
  // untouched), so restoring the originals never rewrites history.
  db.prepare('DELETE FROM prizes WHERE family_id = ?').run(familyId);
  seedPrizes(familyId);
  return getPrizesByFamily(familyId);
}

// --- prize wins ---------------------------------------------------------------
function createPrizeWin({ familyId, kidId, choreId, prizeId, prizeNameAtWin }) {
  const id = newId();
  db.prepare(
    'INSERT INTO prize_wins (id, family_id, kid_id, chore_id, prize_id, prize_name_at_win, won_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, familyId, kidId, choreId, prizeId, prizeNameAtWin, nowIso());
  return db.prepare('SELECT * FROM prize_wins WHERE id = ?').get(id);
}

function getPrizeWinsByFamily(familyId) {
  return db
    .prepare('SELECT * FROM prize_wins WHERE family_id = ? ORDER BY won_at DESC')
    .all(familyId);
}

// --- payouts ------------------------------------------------------------------
function getPayoutById(familyId, payoutId) {
  return db.prepare('SELECT * FROM payouts WHERE id = ? AND family_id = ?').get(payoutId, familyId) || null;
}

function getPayoutByKidWeek(familyId, kidId, weekStart) {
  return (
    db
      .prepare('SELECT * FROM payouts WHERE family_id = ? AND kid_id = ? AND week_start = ?')
      .get(familyId, kidId, weekStart) || null
  );
}

function getPayoutsByFamily(familyId) {
  return db
    .prepare('SELECT * FROM payouts WHERE family_id = ? ORDER BY week_start DESC, paid_at DESC')
    .all(familyId);
}

// Idempotent: the UNIQUE(family_id, kid_id, week_start) constraint plus the
// lookup in the route means the same kid/week can never produce a duplicate.
function createPayout({ familyId, kidId, weekStart, amountCents }) {
  const id = newId();
  db.prepare(
    'INSERT INTO payouts (id, family_id, kid_id, week_start, amount_cents, paid_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, familyId, kidId, weekStart, amountCents, nowIso());
  return getPayoutById(familyId, id);
}

function updatePayout(familyId, payoutId, amountCents) {
  db.prepare('UPDATE payouts SET amount_cents = ? WHERE id = ? AND family_id = ?').run(
    amountCents,
    payoutId,
    familyId
  );
  return getPayoutById(familyId, payoutId);
}

function deletePayout(familyId, payoutId) {
  db.prepare('DELETE FROM payouts WHERE id = ? AND family_id = ?').run(payoutId, familyId);
}

// --- purchases (Play) ---------------------------------------------------------
function getPurchaseByToken(purchaseToken) {
  return db.prepare('SELECT * FROM purchases WHERE purchase_token = ?').get(purchaseToken) || null;
}

function upsertPurchase({ familyId, productId, purchaseToken, state }) {
  const existing = getPurchaseByToken(purchaseToken);
  if (existing) {
    db.prepare('UPDATE purchases SET family_id = ?, product_id = ?, state = ?, verified_at = ? WHERE id = ?').run(
      familyId,
      productId,
      state,
      nowIso(),
      existing.id
    );
    return getPurchaseByToken(purchaseToken);
  }
  const id = newId();
  db.prepare(
    'INSERT INTO purchases (id, family_id, product_id, purchase_token, state, verified_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, familyId, productId, purchaseToken, state, nowIso());
  return getPurchaseByToken(purchaseToken);
}

// --- serialisers (what the client sees; never password/PIN/picture code) ------
function publicKid(row) {
  const xp = row.pet_xp || 0;
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    color: row.color,
    pet: row.pet,
    petXp: xp,
    petStage: util.petStage(xp),
    petAccessory: row.pet_accessory,
    unlockedAccessories: util.unlockedAccessories(xp),
    hasPictureCode: !!row.picture_code,
    createdAt: row.created_at,
  };
}

function publicChore(row) {
  let steps = [];
  try {
    steps = JSON.parse(row.steps || '[]');
  } catch {
    steps = [];
  }
  return {
    id: row.id,
    kidId: row.kid_id,
    name: row.name,
    valueCents: row.value_cents,
    date: row.date,
    status: row.status,
    steps,
    repeatWeekly: row.repeat_weekly === 1,
    starterStar: row.starter_star === 1,
    startedAt: row.started_at,
    createdAt: row.created_at,
  };
}

function publicPrize(row) {
  return {
    id: row.id,
    slot: row.slot,
    name: row.name,
    shortLabel: row.short_label,
    icon: row.icon,
    color: row.color,
  };
}

function publicPrizeWin(row) {
  return {
    id: row.id,
    kidId: row.kid_id,
    choreId: row.chore_id,
    prizeId: row.prize_id,
    prizeNameAtWin: row.prize_name_at_win,
    wonAt: row.won_at,
  };
}

function publicPayout(row) {
  return {
    id: row.id,
    kidId: row.kid_id,
    weekStart: row.week_start,
    amountCents: row.amount_cents,
    paidAt: row.paid_at,
  };
}

// --- money (computed server-side) ---------------------------------------------
// Earned = approved + played (claimed) chores, all time.
// Balance = earned − paid. "Owed this week" = this week's earned − this
// week's recorded payouts, floored at $0 in the header.
function computeMoney(familyId) {
  const weekStart = util.currentWeekStart();
  const weekEnd = util.formatDate(util.addDays(util.parseDate(weekStart), 6));
  const kids = getKidsByFamily(familyId);
  const chores = getChoresByFamily(familyId);
  const payouts = getPayoutsByFamily(familyId);

  const earnedByKid = {};
  const earnedWeekByKid = {};
  for (const c of chores) {
    if (c.status !== 'approved' && c.status !== 'complete') continue;
    earnedByKid[c.kid_id] = (earnedByKid[c.kid_id] || 0) + c.value_cents;
    if (c.date >= weekStart && c.date <= weekEnd) {
      earnedWeekByKid[c.kid_id] = (earnedWeekByKid[c.kid_id] || 0) + c.value_cents;
    }
  }
  const paidByKid = {};
  const paidWeekByKid = {};
  for (const p of payouts) {
    paidByKid[p.kid_id] = (paidByKid[p.kid_id] || 0) + p.amount_cents;
    if (p.week_start === weekStart) {
      paidWeekByKid[p.kid_id] = (paidWeekByKid[p.kid_id] || 0) + p.amount_cents;
    }
  }

  const perKid = kids.map((k) => {
    const earned = earnedByKid[k.id] || 0;
    const paid = paidByKid[k.id] || 0;
    const earnedWeek = earnedWeekByKid[k.id] || 0;
    const paidWeek = paidWeekByKid[k.id] || 0;
    return {
      kidId: k.id,
      earnedCents: earned,
      paidCents: paid,
      balanceCents: earned - paid,
      owedThisWeekCents: Math.max(0, earnedWeek - paidWeek),
    };
  });
  const total = (key) => perKid.reduce((sum, k) => sum + k[key], 0);

  return {
    earnedCents: total('earnedCents'),
    paidCents: total('paidCents'),
    balanceCents: total('balanceCents'),
    owedThisWeekCents: total('owedThisWeekCents'),
    weekStart,
    perKid,
  };
}

/**
 * Weeks still to pay — for the payout reminder. A week counts when a
 * kid earned more in it than was paid for it. Finished weeks always
 * count; the current week joins from Sunday onward.
 */
function weeksStillToPay(familyId) {
  const weekStart = util.currentWeekStart();
  const today = util.todayString();
  const isSunday = util.weekdayOffset(today) === 6;
  const chores = getChoresByFamily(familyId);
  const payouts = getPayoutsByFamily(familyId);

  const earnedByKidWeek = {};
  for (const c of chores) {
    if (c.status !== 'approved' && c.status !== 'complete') continue;
    const ws = util.mondayOf(c.date);
    const key = `${c.kid_id}|${ws}`;
    earnedByKidWeek[key] = (earnedByKidWeek[key] || 0) + c.value_cents;
  }
  const paidByKidWeek = {};
  for (const p of payouts) {
    paidByKidWeek[`${p.kid_id}|${p.week_start}`] = (paidByKidWeek[`${p.kid_id}|${p.week_start}`] || 0) + p.amount_cents;
  }

  const out = [];
  for (const key of Object.keys(earnedByKidWeek)) {
    const [kidId, ws] = key.split('|');
    const earned = earnedByKidWeek[key];
    const paid = paidByKidWeek[key] || 0;
    const owed = earned - paid;
    if (owed <= 0) continue;
    const isCurrentWeek = ws === weekStart;
    if (isCurrentWeek && !isSunday) continue; // current week joins from Sunday
    out.push({ kidId, weekStart: ws, earnedCents: earned, paidCents: paid, owedCents: owed });
  }
  out.sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
  return out;
}

// --- full family state --------------------------------------------------------
function buildFamilyState(familyId, session) {
  ensureRepeatCarryOver(familyId);
  const family = getFamilyById(familyId);
  const money = computeMoney(familyId);
  return {
    session: {
      role: session.role,
      ...(session.kid_id ? { kidId: session.kid_id } : {}),
    },
    plan: family.plan,
    planPeriod: family.plan_period,
    kids: getKidsByFamily(familyId).map(publicKid),
    chores: getChoresByFamily(familyId).map(publicChore),
    prizes: getPrizesByFamily(familyId).map(publicPrize),
    prizeWins: getPrizeWinsByFamily(familyId).map(publicPrizeWin),
    payouts: getPayoutsByFamily(familyId).map(publicPayout),
    displayModes: { calmMode: family.calm_mode === 1, focusMode: family.focus_mode === 1 },
    hasPin: !!family.pin_hash,
    money,
    weeksStillToPay: weeksStillToPay(familyId),
  };
}

module.exports = {
  db,
  getFamilyById,
  getFamilyByEmail,
  createFamily,
  updateFamily,
  createSession,
  getSessionByToken,
  deleteSessionByToken,
  getKidById,
  getKidsByName,
  getKidsByFamily,
  countKids,
  createKid,
  updateKid,
  deleteKid,
  getChoreById,
  getChoresByFamily,
  createChore,
  updateChore,
  deleteChore,
  ensureRepeatCarryOver,
  getPrizesByFamily,
  getPrizeById,
  updatePrize,
  resetPrizes,
  createPrizeWin,
  getPrizeWinsByFamily,
  getPayoutById,
  getPayoutByKidWeek,
  getPayoutsByFamily,
  createPayout,
  updatePayout,
  deletePayout,
  getPurchaseByToken,
  upsertPurchase,
  publicKid,
  publicChore,
  publicPrize,
  publicPrizeWin,
  publicPayout,
  computeMoney,
  weeksStillToPay,
  buildFamilyState,
};
