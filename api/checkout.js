/**
 * POST /api/checkout — create a Stripe Checkout session. (STUBBED)
 *
 * Body: { "mode": "single" | "subscription" }
 *   - "single":       $5 one-time scan credit
 *   - "subscription": $29/month unlimited scans
 *
 * TODO (before launch):
 *   1. `npm install stripe`
 *   2. Set env vars: STRIPE_SECRET_KEY, STRIPE_PRICE_SINGLE,
 *      STRIPE_PRICE_MONTHLY, APP_URL (see SETUP.md + .env.example).
 *   3. Uncomment the Stripe block below.
 *   4. Wire the frontend (js/scan.js) to redirect to `url` on success.
 *
 * Until then this endpoint returns 501 payments_not_configured, and the
 * frontend shows a friendly "payments coming soon" message.
 */
'use strict';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const mode = (req.body && req.body.mode) || 'single';
  if (!['single', 'subscription'].includes(mode)) {
    return res.status(400).json({ error: 'bad_mode' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(501).json({
      error: 'payments_not_configured',
      message: 'Payments are not set up yet. Scans are free during the beta.',
    });
  }

  // TODO: uncomment after `npm install stripe` and setting the price env vars.
  /*
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const price =
    mode === 'subscription' ? process.env.STRIPE_PRICE_MONTHLY : process.env.STRIPE_PRICE_SINGLE;

  const session = await stripe.checkout.sessions.create({
    mode: mode === 'subscription' ? 'subscription' : 'payment',
    line_items: [{ price, quantity: 1 }],
    success_url: `${process.env.APP_URL}/scan.html?paid=1`,
    cancel_url: `${process.env.APP_URL}/#pricing`,
    // TODO: attach the buyer's identity so the webhook can grant scan credits:
    // client_reference_id: <user id or email>,
  });

  return res.status(200).json({ url: session.url });
  */

  return res.status(501).json({
    error: 'payments_not_configured',
    message: 'Payments are not set up yet. Scans are free during the beta.',
  });
};
