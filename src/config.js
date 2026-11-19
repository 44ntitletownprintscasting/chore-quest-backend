'use strict';

/**
 * Config — everything comes from the environment. Fail fast with a plain
 * message when something required is missing.
 *
 * Required:
 *   PORT                     port to listen on (Fly.io sets this via fly.toml [env])
 * Optional:
 *   DATABASE_PATH            SQLite file (default ./data/chore-quest.db;
 *                            Fly.io: /data/chore-quest.db on the volume)
 *   GOOGLE_SERVICE_ACCOUNT_JSON
 *                            Google Play service-account key, either the JSON
 *                            itself or a path to the JSON key file. When it
 *                            is absent (or unreadable) billing verification
 *                            is disabled and POST /api/billing/verify
 *                            answers 503 — it never invents a verification.
 *   PLAY_PACKAGE_NAME        Android app id (default com.playmadecreations.chorequest)
 */
const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`[config] ${message}`);
  process.exit(1);
}

const portRaw = process.env.PORT;
if (!portRaw) {
  fail('PORT is not set. Set PORT in the environment (local dev: PORT=8788) or in fly.toml [env].');
}
const port = parseInt(portRaw, 10);
if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  fail(`PORT is not a valid port number: ${portRaw}`);
}

const databasePath = process.env.DATABASE_PATH || './data/chore-quest.db';
const packageName = process.env.PLAY_PACKAGE_NAME || 'com.playmadecreations.chorequest';

/**
 * Load the Play service-account credentials, if configured.
 * Accepts either inline JSON (value starts with '{') or a path to a
 * .json key file. Returns null when not configured; logs a warning and
 * returns null when configured but unreadable (billing stays disabled
 * rather than crashing the whole server — billing is optional).
 */
function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    return JSON.parse(fs.readFileSync(path.resolve(trimmed), 'utf8'));
  } catch (err) {
    console.error(
      `[config] GOOGLE_SERVICE_ACCOUNT_JSON could not be read/parsed (${err.message}); ` +
        'billing verification is disabled.'
    );
    return null;
  }
}

const serviceAccount = loadServiceAccount();

module.exports = {
  port,
  databasePath,
  packageName,
  serviceAccount,
  billingConfigured: !!serviceAccount,
};
