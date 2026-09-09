/**
 * GET /api/tiers — which pricing tiers are currently enabled.
 *
 * The $20 / 5-scan pack is only offered when STRIPE_PRICE_PACK is set
 * (the owner creates that price in the Stripe dashboard). The frontend
 * fetches this and hides the pack card when it is absent, so an unset
 * env var degrades gracefully instead of selling a broken tier.
 *
 * Returns 200 { tiers: { single: true, pack: bool, subscription: bool } }.
 */
'use strict';

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  return res.status(200).json({
    tiers: {
      single: true,
      pack: !!process.env.STRIPE_PRICE_PACK,
      subscription: true,
    },
  });
};
