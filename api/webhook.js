/**
 * POST /api/webhook — Stripe webhook receiver. (STUBBED)
 *
 * TODO (before launch):
 *   1. `npm install stripe`
 *   2. Set STRIPE_WEBHOOK_SECRET (from the Stripe Dashboard webhook endpoint).
 *   3. Point a Stripe webhook at https://YOUR-DOMAIN/api/webhook
 *      listening for: checkout.session.completed,
 *      customer.subscription.created / deleted.
 *   4. Uncomment the verification block below, then implement credit
 *      granting (e.g. write to your database: single-scan credits or an
 *      active-subscription flag keyed by client_reference_id / customer id).
 *
 * NOTE: this route needs the RAW request body for signature verification.
 * On Vercel, disable the default JSON body parser for this route (see the
 * commented config below) and read the raw buffer instead.
 */
'use strict';

// TODO: uncomment when enabling webhooks on Vercel.
// module.exports.config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(501).json({ error: 'payments_not_configured' });
  }

  // TODO: verify the signature and handle events.
  /*
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  // const rawBody = await readRawBody(req); // implement raw-body reader
  // const event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  //
  // switch (event.type) {
  //   case 'checkout.session.completed': {
  //     const session = event.data.object;
  //     // TODO: if mode === 'payment' -> grant 1 scan credit;
  //     //       if mode === 'subscription' -> mark subscription active.
  //     // Key by session.client_reference_id or session.customer.
  //     break;
  //   }
  //   case 'customer.subscription.deleted': {
  //     // TODO: mark subscription inactive.
  //     break;
  //   }
  // }
  */

  return res.status(200).json({ received: true });
};
