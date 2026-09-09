/**
 * POST /api/webhook — Stripe webhook receiver.
 *
 * Verified events:
 *   checkout.session.completed — single purchase  -> +N scan credits
 *                                (N from session metadata fp_credits_grant,
 *                                default 1)
 *                                subscription      -> fp_sub_active = "true"
 *   customer.subscription.created / updated       -> fp_sub_active from status
 *   customer.subscription.deleted                 -> fp_sub_active = "false"
 *
 * Entitlements are stored on the Stripe Customer's metadata (see
 * lib/entitlements.js) — no database needed. State is always DERIVED
 * (read current metadata, write the new value), never blindly appended, so
 * redelivered events converge instead of double-counting.
 *
 * IMPORTANT (Vercel): the JSON body parser is disabled below so Stripe's
 * signature can be verified against the raw bytes. Do not re-enable it.
 *
 * Always returns 200 — Stripe retries anything else, and a thrown error
 * would spam retries. Problems are logged, never thrown.
 */
'use strict';

// Disable Vercel's default body parser: we need the RAW body for signatures.
module.exports.config = { api: { bodyParser: false } };

const { getStripe } = require('../lib/stripe');
const {
  addCredits,
  setSubscriptionActive,
  markEverPaid,
  normalizeEmail,
} = require('../lib/entitlements');

/** Read the raw request body as a Buffer. */
function readRawBody(req) {
  // Tolerate pre-parsed bodies (local dev servers) when possible.
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body, 'utf8'));
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 1024 * 1024) {
        // Webhook payloads are small; abort pathological ones.
        req.destroy();
        reject(new Error('body_too_large'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Resolve a Stripe customer id from a checkout session or subscription. */
async function resolveCustomerId(stripe, obj) {
  if (obj && obj.customer) return String(obj.customer);
  const email = normalizeEmail((obj && (obj.customer_email || obj.client_reference_id)) || '');
  if (!email) return null;
  const list = await stripe.customers.list({ email, limit: 1 });
  const customer = list && list.data && list.data[0];
  return customer ? customer.id : null;
}

async function handleEvent(stripe, event) {
  const obj = event.data && event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const customerId = await resolveCustomerId(stripe, obj);
      if (!customerId) {
        console.error('webhook: checkout.session.completed with no resolvable customer', event.id);
        return;
      }
      if (obj.mode === 'payment') {
        // Sessions created by /api/checkout carry fp_credits_grant ("1" or
        // "5"); older sessions without it default to 1.
        const grant = parseInt((obj.metadata && obj.metadata.fp_credits_grant) || '1', 10);
        await addCredits(customerId, Number.isFinite(grant) && grant > 0 ? grant : 1);
        // Lifetime-paid marker for chat Q&A gating (api/chat.js): a buyer
        // who later spends their last credit is still a paying customer,
        // not a free-teaser user.
        await markEverPaid(customerId);
      } else if (obj.mode === 'subscription') {
        await setSubscriptionActive(customerId, true);
      }
      return;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const customerId = await resolveCustomerId(stripe, obj);
      if (!customerId) {
        console.error('webhook: subscription event with no resolvable customer', event.id);
        return;
      }
      const active = obj.status === 'active' || obj.status === 'trialing';
      await setSubscriptionActive(customerId, active);
      return;
    }

    case 'customer.subscription.deleted': {
      const customerId = await resolveCustomerId(stripe, obj);
      if (!customerId) {
        console.error('webhook: subscription.deleted with no resolvable customer', event.id);
        return;
      }
      await setSubscriptionActive(customerId, false);
      return;
    }

    default:
      // Unhandled event types are fine — acknowledge and ignore.
      return;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripe = getStripe();
  if (!webhookSecret || !stripe) {
    return res.status(501).json({ error: 'payments_not_configured' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('webhook: could not read body:', err && err.message);
    return res.status(400).json({ error: 'bad_body' });
  }

  const sig = req.headers && req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('webhook: signature verification failed:', err && err.message);
    return res.status(400).json({ error: 'bad_signature' });
  }

  try {
    await handleEvent(stripe, event);
  } catch (err) {
    // Log, but still 200: Stripe would otherwise retry a poison event forever.
    console.error('webhook: handler error for', event.type, err && err.message);
  }
  return res.status(200).json({ received: true });
};
