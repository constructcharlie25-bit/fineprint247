/**
 * lib/stripe.js — lazy Stripe client factory.
 *
 * Returns null when STRIPE_SECRET_KEY is not set (payments disabled).
 * The require('stripe') call is lazy so tests can swap the module out via
 * the require cache without touching this file.
 *
 * No secrets here — the key comes from process.env at call time.
 */
'use strict';

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const Stripe = require('stripe');
  return Stripe(key);
}

module.exports = { getStripe };
