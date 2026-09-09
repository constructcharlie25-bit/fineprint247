/**
 * lib/entitlements.js — who may scan, without a database.
 *
 * MVP constraint: no paid database. Entitlements live on the Stripe Customer
 * object's metadata:
 *   fp_credits    — integer-as-string, single-scan credits remaining
 *   fp_sub_active — "true" | "false", unlimited subscription status
 *   fp_free_used  — "1" once the one-time free teaser has been claimed
 *   fp_chat_used  — integer-as-string, free follow-up Q&A questions consumed
 *                   (see api/chat.js; the free tier gets exactly 2)
 *   fp_ever_paid  — "1" once the customer has completed any one-time payment.
 *                   Distinguishes a $5 buyer who already spent their last
 *                   credit from a free-teaser user who never paid — both
 *                   otherwise read as { credits: 0, subActive: false }.
 *
 * The webhook (api/webhook.js) writes these; the scanner (api/scan.js) reads
 * them. All values are re-derived from Stripe on every call, so a redeploy
 * or instance restart loses nothing.
 */
'use strict';

const { getStripe } = require('./stripe');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  const e = normalizeEmail(email);
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
}

function parseCredits(metadata) {
  const n = parseInt((metadata && metadata.fp_credits) || '0', 10);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function parseSubActive(metadata) {
  return (metadata && metadata.fp_sub_active) === 'true';
}

/**
 * Look up a customer's entitlement by email.
 * Returns { credits, subActive, customerId } — all zeroed when the customer
 * is unknown or payments are not configured.
 */
async function getEntitlement(email) {
  const stripe = getStripe();
  const empty = { credits: 0, subActive: false, customerId: null };
  if (!stripe) return empty;
  const clean = normalizeEmail(email);
  if (!isValidEmail(clean)) return empty;

  const list = await stripe.customers.list({ email: clean, limit: 1 });
  const customer = list && list.data && list.data[0];
  if (!customer) return empty;

  const md = customer.metadata || {};
  return {
    credits: parseCredits(md),
    subActive: parseSubActive(md),
    customerId: customer.id,
  };
}

/**
 * Decrement a customer's single-scan credits by one (floors at 0).
 * Returns the remaining credit count. No-op when payments are off.
 */
async function decrementCredit(customerId) {
  const stripe = getStripe();
  if (!stripe || !customerId) return 0;
  const customer = await stripe.customers.retrieve(customerId);
  const md = (customer && customer.metadata) || {};
  const next = Math.max(0, parseCredits(md) - 1);
  await stripe.customers.update(customerId, {
    metadata: { ...md, fp_credits: String(next) },
  });
  return next;
}

/**
 * Add `n` single-scan credits (used by the webhook after a $5 purchase).
 * Derives the new total from current metadata — idempotent per event only
 * when each purchase delivers a distinct event (Stripe guarantees
 * at-least-once delivery of distinct events).
 */
async function addCredits(customerId, n) {
  const stripe = getStripe();
  if (!stripe || !customerId) return 0;
  const customer = await stripe.customers.retrieve(customerId);
  const md = (customer && customer.metadata) || {};
  const next = parseCredits(md) + Math.max(0, n);
  await stripe.customers.update(customerId, {
    metadata: { ...md, fp_credits: String(next) },
  });
  return next;
}

/** Set the unlimited-subscription flag (used by the webhook). */
async function setSubscriptionActive(customerId, active) {
  const stripe = getStripe();
  if (!stripe || !customerId) return;
  const customer = await stripe.customers.retrieve(customerId);
  const md = (customer && customer.metadata) || {};
  await stripe.customers.update(customerId, {
    metadata: { ...md, fp_sub_active: active ? 'true' : 'false' },
  });
}

/**
 * Find-or-create a Stripe Customer by email, then claim the one-time free
 * scan (used by api/scan.js's free-tier gate).
 *
 * Returns { customerId, alreadyClaimed }.
 *   - alreadyClaimed === false: fp_free_used was just set to "1" on the
 *     customer in the same metadata write — the caller may now serve the
 *     teaser once.
 *   - alreadyClaimed === true: the free teaser was claimed before.
 *
 * Throws when Stripe is unreachable or rejects the email. The caller maps
 * that to a 502 — the scan itself is never served on a failed claim.
 *
 * Race note: two requests for the same email are serialized by the
 * caller's per-email lock (see api/scan.js). Across serverless instances a
 * true simultaneous race could double-grant; the cost of that is one extra
 * ~$0.002 LLM scan, so no stronger primitive is warranted.
 */
async function claimFreeScan(email) {
  const stripe = getStripe();
  if (!stripe) throw new Error('payments_not_configured');
  const clean = normalizeEmail(email);
  if (!isValidEmail(clean)) throw new Error('bad_email');

  const list = await stripe.customers.list({ email: clean, limit: 1 });
  let customer = list && list.data && list.data[0];
  if (!customer) {
    customer = await stripe.customers.create({ email: clean });
  }
  const md = (customer && customer.metadata) || {};
  if (md.fp_free_used === '1') {
    return { customerId: customer.id, alreadyClaimed: true };
  }
  const updated = await stripe.customers.update(customer.id, {
    metadata: { ...md, fp_free_used: '1' },
  });
  void updated;
  return { customerId: customer.id, alreadyClaimed: false };
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  getEntitlement,
  decrementCredit,
  addCredits,
  setSubscriptionActive,
  claimFreeScan,
  getChatUsage,
  incrementChatUsage,
  markEverPaid,
};

/* ------------------------------------------------------------------ */
/* Follow-up Q&A chat usage (used by api/chat.js)                      */
/* ------------------------------------------------------------------ */

/**
 * Read a customer's chat usage for the free-question budget.
 * Find-or-create keeps the counter writable for customers that predate
 * the chat feature.
 *
 * Returns { used, everPaid, customerId } — all zeroed when payments are
 * not configured. Throws when Stripe is unreachable (the caller fails
 * closed).
 */
async function getChatUsage(email) {
  const stripe = getStripe();
  const empty = { used: 0, everPaid: false, customerId: null };
  if (!stripe) return empty;
  const clean = normalizeEmail(email);
  if (!isValidEmail(clean)) return empty;

  const list = await stripe.customers.list({ email: clean, limit: 1 });
  let customer = list && list.data && list.data[0];
  if (!customer) {
    customer = await stripe.customers.create({ email: clean });
  }
  const md = (customer && customer.metadata) || {};
  const used = parseInt(md.fp_chat_used || '0', 10);
  return {
    used: Number.isFinite(used) ? Math.max(0, used) : 0,
    everPaid: md.fp_ever_paid === '1',
    customerId: customer.id,
  };
}

/**
 * Increment a customer's free-question counter by one. Derives the new
 * total from current metadata (same pattern as addCredits), so redelivered
 * calls converge instead of double-counting.
 * Returns the new count. No-op when payments are off.
 */
async function incrementChatUsage(customerId) {
  const stripe = getStripe();
  if (!stripe || !customerId) return 0;
  const customer = await stripe.customers.retrieve(customerId);
  const md = (customer && customer.metadata) || {};
  const cur = parseInt(md.fp_chat_used || '0', 10);
  const next = Math.max(0, Number.isFinite(cur) ? cur : 0) + 1;
  await stripe.customers.update(customerId, {
    metadata: { ...md, fp_chat_used: String(next) },
  });
  return next;
}

/**
 * Mark a customer as a lifetime payer (used by the webhook after a
 * one-time payment completes). Idempotent.
 */
async function markEverPaid(customerId) {
  const stripe = getStripe();
  if (!stripe || !customerId) return;
  const customer = await stripe.customers.retrieve(customerId);
  const md = (customer && customer.metadata) || {};
  if (md.fp_ever_paid === '1') return;
  await stripe.customers.update(customerId, {
    metadata: { ...md, fp_ever_paid: '1' },
  });
}
