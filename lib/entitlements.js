/**
 * lib/entitlements.js — who may scan, without a database.
 *
 * MVP constraint: no paid database. Entitlements live on the Stripe Customer
 * object's metadata:
 *   fp_credits    — integer-as-string, single-scan credits remaining
 *   fp_sub_active — "true" | "false", unlimited subscription status
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

module.exports = {
  normalizeEmail,
  isValidEmail,
  getEntitlement,
  decrementCredit,
  addCredits,
  setSubscriptionActive,
};
