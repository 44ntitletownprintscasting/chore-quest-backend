'use strict';

/**
 * Google Play billing verification — server-side only, via the Google Play
 * Developer API (androidpublisher.purchases.subscriptionsv2.get).
 *
 * Flow (no webhook — the client sends the purchase token after the Play
 * purchase completes, and this endpoint verifies it with Google):
 *   1. Look up the subscription by purchase token.
 *   2. It must be an active subscription (ACTIVE, IN_GRACE_PERIOD, or
 *      CANCELED-but-not-yet-expired). Anything else is not active.
 *   3. It must be for the productId the client claimed (checked against
 *      the subscription's line items).
 *   4. Free trial = a line item whose offerPhase is a free trial
 *      (lineItems[].offerPhase.freeTrial) — that is how the v2 API reports
 *      it; there is no separate "trial" subscription state.
 *   5. On success the family plan becomes "pro" (or "trial" while in the
 *      trial state) + the product's period, and the purchase is stored.
 *   The whole check is capped at 20 seconds — a hung Google call fails
 *   with a clean 502 instead of leaving the request open.
 *
 * Without service-account credentials configured this module reports
 * itself as unconfigured and the route answers 503 — a verification is
 * never invented. Credentials come only from GOOGLE_SERVICE_ACCOUNT_JSON
 * (inline JSON or a path to the key file; see config.js).
 */
const { google } = require('googleapis');
const config = require('./config');

const PACKAGE_NAME = config.packageName;

const PRODUCTS = [
  { productId: 'chore_quest_pro_monthly', period: 'monthly', price: '$4.99', priceCents: 499 },
  { productId: 'chore_quest_pro_yearly', period: 'yearly', price: '$39.99', priceCents: 3999 },
];

function getProduct(productId) {
  return PRODUCTS.find((p) => p.productId === productId) || null;
}

let publisherPromise = null;

function getPublisher() {
  if (!config.billingConfigured) return null;
  if (!publisherPromise) {
    publisherPromise = (async () => {
      const auth = new google.auth.GoogleAuth({
        credentials: config.serviceAccount,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });
      const authClient = await auth.getClient();
      return google.androidpublisher({ version: 'v3', auth: authClient });
    })();
    // If auth setup fails, don't cache the failure forever.
    publisherPromise.catch(() => {
      publisherPromise = null;
    });
  }
  return publisherPromise;
}

class BillingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Google's token + API round-trip normally takes a second or two. If it
// hangs (no network, bad credentials, Google down) fail cleanly instead of
// leaving the client's request open indefinitely.
const VERIFY_TIMEOUT_MS = 20000;

/**
 * Verify a Play purchase token for a product.
 * Returns { active, inTrial, state, productIds, expiryTime }.
 * Throws BillingError with an HTTP status the route can forward.
 */
async function verifySubscription(productId, purchaseToken) {
  const work = verifySubscriptionInner(productId, purchaseToken);
  // Keep the losing promise from surfacing as an unhandled rejection.
  work.catch(() => {});
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new BillingError(502, 'Google Play verification timed out. Please try again.')),
      VERIFY_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function verifySubscriptionInner(productId, purchaseToken) {
  const publisher = await getPublisher();
  let response;
  try {
    response = await publisher.purchases.subscriptionsv2.get({
      packageName: PACKAGE_NAME,
      token: purchaseToken,
    });
  } catch (err) {
    const code = err && err.code;
    if (code === 404) {
      throw new BillingError(400, 'That purchase could not be found in Google Play.');
    }
    if (code === 403) {
      throw new BillingError(
        502,
        'Google Play rejected the service account. Check API access in Play Console.'
      );
    }
    if (code === 400) {
      throw new BillingError(400, 'Google Play rejected this purchase token.');
    }
    console.error('[billing] Play API error:', err && err.message ? err.message : err);
    throw new BillingError(502, 'Could not verify the purchase with Google Play. Please try again.');
  }

  const sub = response.data || {};
  const state = sub.subscriptionState || 'SUBSCRIPTION_STATE_UNSPECIFIED';
  const lineItems = Array.isArray(sub.lineItems) ? sub.lineItems : [];
  const productIds = lineItems.map((li) => li.productId).filter(Boolean);
  const expiryTimes = lineItems.map((li) => li.expiryTime).filter(Boolean).sort();
  const expiryTime = expiryTimes.length ? expiryTimes[expiryTimes.length - 1] : null;
  const inTrial = lineItems.some((li) => li.offerPhase && li.offerPhase.freeTrial);

  let active = state === 'SUBSCRIPTION_STATE_ACTIVE' || state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';
  if (state === 'SUBSCRIPTION_STATE_CANCELED' && expiryTime) {
    // Canceled but paid up: still active until the expiry time passes.
    active = new Date(expiryTime).getTime() > Date.now();
  }

  return { active, inTrial, state, productIds, expiryTime };
}

module.exports = {
  PRODUCTS,
  getProduct,
  verifySubscription,
  BillingError,
  isConfigured: () => config.billingConfigured,
};
