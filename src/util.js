'use strict';

/**
 * Shared helpers: dates (weeks are Monday–Sunday, handled as UTC dates so
 * a "YYYY-MM-DD" means the same day on every device), validation, the
 * pet XP rules, and the original 8 prizes.
 */

// --- dates ------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// "YYYY-MM-DD" -> Date at UTC midnight.
function parseDate(s) {
  return new Date(`${s}T00:00:00Z`);
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

// Monday (week start) of the week containing the given date string.
function mondayOf(dateStr) {
  const d = parseDate(dateStr);
  // getUTCDay: 0 = Sunday … 6 = Saturday. Monday-based offset: Mon=0 … Sun=6.
  const offset = (d.getUTCDay() + 6) % 7;
  return formatDate(addDays(d, -offset));
}

// Monday of the current week, in UTC.
function currentWeekStart() {
  return mondayOf(formatDate(new Date()));
}

function todayString() {
  return formatDate(new Date());
}

// Weekday offset of a date within its week (Monday = 0 … Sunday = 6).
function weekdayOffset(dateStr) {
  const d = parseDate(dateStr);
  return (d.getUTCDay() + 6) % 7;
}

// --- validation ---------------------------------------------------------------
function isNonEmptyString(v, maxLen = 200) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= maxLen;
}

function isInt(v, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(v) && v >= min && v <= max;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Normalise a steps value from the client: accepts ["Brush teeth", ...]
// or [{text, done}, ...]; always returns [{text, done}, ...].
function normaliseSteps(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const s of input) {
    if (typeof s === 'string') {
      if (s.trim()) out.push({ text: s.trim(), done: false });
    } else if (s && typeof s === 'object' && typeof s.text === 'string' && s.text.trim()) {
      out.push({ text: s.text.trim(), done: s.done === true });
    } else {
      return null;
    }
  }
  return out;
}

// --- pet rules ----------------------------------------------------------------
// Pet stages: baby -> little -> big. Accessories unlock by XP.
// These thresholds are server-chosen defaults; the client reads the
// unlocked list from the kid object in /api/state, it does not hardcode them.
const PETS = ['fox', 'lion', 'panda', 'bunny', 'dinosaur', 'cat'];
const ACCESSORY_UNLOCK_XP = { hat: 3, bow: 6, star: 10 };

function petStage(xp) {
  if (xp >= 10) return 'big';
  if (xp >= 5) return 'little';
  return 'baby';
}

function unlockedAccessories(xp) {
  return Object.keys(ACCESSORY_UNLOCK_XP).filter((a) => xp >= ACCESSORY_UNLOCK_XP[a]);
}

// --- prizes -------------------------------------------------------------------
// The original 8 game prizes. A family's set starts as a copy of these;
// parents may edit them, and POST /api/prizes/reset restores exactly these.
const DEFAULT_PRIZES = [
  { slot: 1, name: 'Extra Screen Time', shortLabel: 'Screen Time', icon: '📱', color: '#6366f1' },
  { slot: 2, name: "Pick What's for Dinner", shortLabel: 'Pick Dinner', icon: '🍕', color: '#f59e0b' },
  { slot: 3, name: 'Ice Cream Trip', shortLabel: 'Ice Cream', icon: '🍦', color: '#ec4899' },
  { slot: 4, name: 'Stay Up 30 Minutes Late', shortLabel: 'Stay Up Late', icon: '🌙', color: '#8b5cf6' },
  { slot: 5, name: 'Movie Night', shortLabel: 'Movie Night', icon: '🎬', color: '#ef4444' },
  { slot: 6, name: 'New Sticker', shortLabel: 'Sticker', icon: '⭐', color: '#eab308' },
  { slot: 7, name: 'Special Treat', shortLabel: 'Treat', icon: '🍪', color: '#f97316' },
  { slot: 8, name: 'Choose a Family Game', shortLabel: 'Pick a Game', icon: '🎲', color: '#22c55e' },
];

module.exports = {
  isValidDateString,
  parseDate,
  formatDate,
  addDays,
  mondayOf,
  currentWeekStart,
  todayString,
  weekdayOffset,
  isNonEmptyString,
  isInt,
  isValidEmail,
  normaliseSteps,
  PETS,
  ACCESSORY_UNLOCK_XP,
  petStage,
  unlockedAccessories,
  DEFAULT_PRIZES,
};
