/**
 * POST /api/checkout — create a Stripe Checkout session.
 *
 * Body: { "mode": "single" | "subscription", "email": "buyer@example.com" }
 *   - "single":       $5 one-time, grants 1 scan credit (STRIPE_PRICE_SINGLE)
 *   - "subscription": $29/month unlimited scans (STRIPE_PRICE_MONTHLY)
 *
 * The buyer's email is passed as both customer_email and client_reference_id
 * so the webhook can credit the right Stripe Customer afterward.
 *
 * Returns 200 { url } — the frontend redirects the browser there.
 * Returns 501 payments_not_configured until STRIPE_SECRET_KEY is set.
 */
'use strict';

const { getStripe } = require('../lib/stripe');
const { isValidEmail, normalizeEmail } = require('../lib/entitlements');
const { checkRateLimit, clientIp } = require('../lib/ratelimit');

// 10 checkout attempts per 10 minutes per IP (best-effort, in-memory).
const CHECKOUT_LIMIT = 10;
const CHECKOUT_WINDOW_MS = 10 * 60 * 1000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!checkRateLimit(`checkout:${clientIp(req)}`, CHECKOUT_LIMIT, CHECKOUT_WINDOW_MS)) {
    return res.status(429).json({
      error: 'rate_limited',
      message: 'Too many checkout attempts. Please wait a few minutes and try again.',
    });
  }

  const mode = (req.body && req.body.mode) || 'single';
  if (!['single', 'subscription'].includes(mode)) {
    return res.status(400).json({ error: 'bad_mode' });
  }

  const stripe = getStripe();
  if (!stripe) {
    return res.status(501).json({
      error: 'payments_not_configured',
      message: 'Payments are not set up yet. Scans are free during the beta.',
    });
  }

  const email = normalizeEmail(req.body && req.body.email);
  if (!isValidEmail(email)) {
    return res.status(400).json({
      error: 'bad_email',
      message: 'Please enter a valid email address so we can deliver your scan credits.',
    });
  }

  const priceId =
    mode === 'subscription' ? process.env.STRIPE_PRICE_MONTHLY : process.env.STRIPE_PRICE_SINGLE;
  if (!priceId) {
    console.error('checkout misconfigured: missing price env var for mode', mode);
    return res.status(500).json({
      error: 'payments_misconfigured',
      message: 'Payments are temporarily unavailable. Please try again later.',
    });
  }

  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '') || 'https://fineprint247.com';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: mode === 'subscription' ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      client_reference_id: email,
      success_url: `${appUrl}/scan.html?paid=1&email=${encodeURIComponent(email)}`,
      cancel_url: `${appUrl}/#pricing`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('checkout session create failed:', err && err.message);
    return res.status(502).json({
      error: 'checkout_failed',
      message: 'Could not start checkout. Please try again.',
    });
  }
};
