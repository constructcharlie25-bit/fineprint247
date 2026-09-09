/**
 * POST /api/unlock — redeem a paid unlock token for the full report, instantly.
 *
 * Body: { email, token }
 *
 * The client receives an encrypted unlock token with the free teaser (see
 * /api/scan and lib/token.js). After the $5 Stripe Checkout succeeds, the
 * client POSTs the token here. A valid, unexpired, untampered token that is
 * bound to the request email returns the complete report — score, summary,
 * every flagged clause, and every negotiation email template — with NO
 * additional LLM call.
 *
 * Entitlement is still verified: the caller must be an active subscriber or
 * hold at least one scan credit (the webhook grants one on checkout
 * completion; non-subscribers spend it here). Without payment the endpoint
 * answers 402 and never reveals the report.
 *
 * Failure modes:
 * - missing/invalid/tampered token      -> 400/403 (no credit spent)
 * - token bound to a different email     -> 403 (no credit spent)
 * - expired token (24h)                  -> 410; the paid user can still
 *   get the full report via a fresh paid re-scan (POST /api/scan).
 * - no paid entitlement                  -> 402 (no credit spent)
 */
'use strict';

const { getStripe } = require('../lib/stripe');
const {
  isValidEmail,
  normalizeEmail,
  getEntitlement,
  decrementCredit,
} = require('../lib/entitlements');
const { openUnlockToken } = require('../lib/token');
const { checkRateLimit, clientIp, _reset } = require('../lib/ratelimit');

const UNLOCK_LIMIT = 20;
const UNLOCK_WINDOW_MS = 10 * 60 * 1000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!checkRateLimit(`unlock:${clientIp(req)}`, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)) {
    return res.status(429).json({
      error: 'rate_limited',
      message: 'Too many unlock attempts. Please wait a few minutes and try again.',
    });
  }

  const body = req.body || {};
  const email = normalizeEmail(body.email || '');
  const token = String(body.token || '');

  if (!isValidEmail(email)) {
    return res.status(400).json({
      error: 'email_required',
      message: 'Enter the email you used at checkout.',
    });
  }
  if (!token) {
    return res.status(400).json({
      error: 'unlock_token_required',
      message:
        'We could not find your unlock token. Your purchase is still valid — scan again while logged in with your checkout email for a fresh full report.',
    });
  }

  let opened;
  try {
    opened = openUnlockToken(token);
  } catch (err) {
    if (err && err.message === 'expired') {
      return res.status(410).json({
        error: 'unlock_expired',
        message:
          'This unlock link expired after 24 hours. Scan again — your paid credit still gets you the full report instantly.',
      });
    }
    return res.status(403).json({
      error: 'unlock_invalid',
      message:
        'This unlock token is not valid. Scan again after payment for a fresh full report.',
    });
  }

  // The token is bound to the email that claimed the teaser; it cannot be
  // redeemed by a different address.
  if (normalizeEmail(opened.email) !== email) {
    return res.status(403).json({
      error: 'unlock_invalid',
      message: 'This unlock token belongs to a different email address.',
    });
  }

  // Fail closed: no paid entitlement, no report — even with a valid token.
  let entitlement;
  try {
    entitlement = await getEntitlement(email);
  } catch (err) {
    console.error('unlock: entitlement lookup failed:', err && err.message);
    return res.status(500).json({
      error: 'entitlement_check_failed',
      message: 'We could not verify your purchase. Please try again in a moment.',
    });
  }

  if (!entitlement.subActive && entitlement.credits <= 0) {
    return res.status(402).json({
      error: 'payment_required',
      message: 'Complete checkout to unlock your full report.',
    });
  }

  // Spend one credit for non-subscribers (mirrors the paid path of /api/scan).
  // If the decrement fails, log and continue — the report was already
  // paid for, so failing open on the accounting write is the lesser evil.
  if (!entitlement.subActive && entitlement.customerId) {
    try {
      await decrementCredit(entitlement.customerId);
    } catch (err) {
      console.error('unlock: credit decrement failed:', err && err.message);
    }
  }

  const r = opened.report || {};
  return res.status(200).json({
    unlocked: true,
    demoMode: !!r.demoMode,
    score: r.score,
    summary: r.summary,
    flags: Array.isArray(r.flags) ? r.flags : [],
  });
};

module.exports._resetRateLimits = _reset;
