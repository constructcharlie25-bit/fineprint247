/**
 * POST /api/scan — scan a contract.
 *
 * Request body (JSON): { text } or { fileBase64, fileName, mimeType }, plus
 * an optional email query param (?email=) or body.email.
 *
 * Pricing model (when STRIPE_SECRET_KEY is set):
 * - FREE: the user gets a TEASER — the 0-100 risk score, severity counts,
 *   and the first finding shown in full (its pushback email template stays
 *   locked) — plus an encrypted unlock token (see lib/token.js) and a
 *   "Unlock the full report — $5" call to action. One teaser per email,
 *   tracked in the Stripe Customer metadata flag fp_free_used.
 * - PAID: after the $5 checkout succeeds, the client submits the unlock
 *   token to POST /api/unlock and receives the full report instantly with
 *   no new LLM call. If the token is missing/expired/invalid (or the
 *   report was too large to tokenize), a paid scan falls back to a fresh
 *   paid analysis.
 * - DIRECT BUY: pay first, then POST here — a subscriber or credit holder
 *   gets the full report immediately (one credit is spent).
 *
 * Fail-closed properties:
 * - A teaser is only issued AFTER the fp_free_used claim succeeds in
 *   Stripe; a Stripe failure during the claim returns 502 and grants
 *   nothing.
 * - Entitlement checks throw on Stripe failure, so errors never
 *   accidentally grant paid scans.
 */
'use strict';

const { analyzeContract, extractText, toClientReport } = require('../lib/analysis');
const { getStripe } = require('../lib/stripe');
const {
  isValidEmail,
  normalizeEmail,
  getEntitlement,
  decrementCredit,
  claimFreeScan,
} = require('../lib/entitlements');
const { sealUnlockToken } = require('../lib/token');
const { checkRateLimit, clientIp, _reset } = require('../lib/ratelimit');

const SCAN_LIMIT = 20;
const SCAN_WINDOW_MS = 10 * 60 * 1000;
const MAX_TEXT_CHARS = 100000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// Serialize same-email free claims within this instance so a double-click
// can't slip two claims past the non-atomic Stripe metadata read/write.
// Each caller chains on a gate promise that resolves only after the previous
// caller's claim settles; the gate is removed from the map once done.
const claimLocks = new Map();
function withClaimLock(email, fn) {
  const key = normalizeEmail(email);
  const prev = claimLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  claimLocks.set(key, gate);
  gate.then(() => {
    if (claimLocks.get(key) === gate) claimLocks.delete(key);
  });
  const task = prev.then(() => fn());
  task.then(release, release);
  return task;
}

function severityCounts(flags) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of flags || []) {
    const sev = String((f && (f.severity || f.risk)) || '').toLowerCase();
    if (counts[sev] !== undefined) counts[sev] += 1;
    else counts.low += 1;
  }
  return counts;
}

/**
 * Build the free teaser payload from a CLIENT-SCHEMA report (see
 * toClientReport): score, severity counts, and the first finding shown in
 * full — but NOT the complete report. The pushback email template stays
 * locked so unlocking has something to unlock; the client renders an
 * upsell in its place.
 */
function buildTeaser(client, email) {
  const flags = Array.isArray(client.flags) ? client.flags : [];
  const counts = severityCounts(flags);
  const first = flags[0] || null;

  const topFlag = first
    ? {
        severity: first.severity,
        clause: first.clause,
        title: first.title,
        risk: first.risk,
        negotiation: first.negotiation,
        legalReview: !!first.legalReview,
        // negotiationEmail intentionally omitted from the teaser
        // (locked until the full report is unlocked).
      }
    : null;

  // Seal the complete report so the paid unlock is instant (no re-scan).
  let unlockToken = null;
  let unlockExpiresAt = null;
  let unlockViaRescan = false;
  try {
    const sealed = sealUnlockToken(
      {
        demoMode: !!client.demoMode,
        score: client.score,
        summary: client.summary,
        flags,
      },
      email
    );
    if (sealed.tooLarge) {
      // Encrypted report exceeded ~100KB: no token issued. After payment
      // the client falls back to a fresh paid analysis (see /api/unlock).
      unlockViaRescan = true;
    } else {
      unlockToken = sealed.token;
      unlockExpiresAt = sealed.expiresAt;
    }
  } catch (err) {
    // Token sealing requires STRIPE_WEBHOOK_SECRET; without it a teaser can
    // never be unlocked, so fail closed instead of granting one.
    throw new Error('teaser_token_failed: ' + (err && err.message));
  }

  return {
    teaser: true,
    demoMode: !!client.demoMode,
    score: client.score,
    summary: client.summary,
    severityCounts: counts,
    totalFindings: flags.length,
    topFlag,
    unlockToken,
    unlockExpiresAt,
    unlockViaRescan,
    cta: {
      label: 'Unlock the full report — $5',
      price: 5,
    },
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  if (!checkRateLimit(`scan:${clientIp(req)}`, SCAN_LIMIT, SCAN_WINDOW_MS)) {
    return res.status(429).json({
      error: 'rate_limited',
      message: 'Too many scans from this address. Please wait a few minutes and try again.',
    });
  }

  // --- Input parsing first: never touch Stripe for garbage input ---
  let text = '';
  try {
    const body = req.body || {};
    if (body.text && typeof body.text === 'string') {
      text = body.text;
    } else if (body.fileBase64 && (body.filename || body.fileName)) {
      const buffer = Buffer.from(String(body.fileBase64), 'base64');
      if (buffer.length > MAX_FILE_BYTES) {
        return res.status(413).json({ error: 'file_too_large', message: 'File must be under 4MB.' });
      }
      try {
        text = await extractText(buffer, String(body.filename || body.fileName));
      } catch (e) {
        if (e && e.code === 'unsupported_file') {
          return res.status(400).json({ error: 'unsupported_file', message: 'Please upload a PDF, DOCX, or TXT file.' });
        }
        return res.status(422).json({ error: 'could_not_parse_file', message: 'We could not read that file. Try copy-pasting the text instead.' });
      }
    } else {
      return res.status(400).json({
        error: 'no_input',
        message: 'Paste contract text or upload a file to scan.',
      });
    }
  } catch (err) {
    return res.status(400).json({
      error: 'bad_input',
      message: 'Could not read that input. Try pasting the text instead.',
    });
  }
  text = text.trim();
  if (text.length < 50) {
    return res.status(400).json({
      error: 'text_too_short',
      message: 'Please provide more contract text (at least a few sentences).',
    });
  }
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);

  const email = normalizeEmail(
    (req.body && req.body.email) || (req.query && req.query.email) || ''
  );
  const paymentsLive = !!getStripe();

  // Beta path: payments not wired up yet — everyone gets the full report.
  if (!paymentsLive) {
    const client = toClientReport(await analyzeContract(text));
    return res.status(200).json({
      demoMode: client.demoMode,
      score: client.score,
      summary: client.summary,
      flags: client.flags,
    });
  }

  // Live path: an email is required — it claims the free teaser and it
  // identifies paid scans.
  if (!isValidEmail(email)) {
    return res.status(400).json({
      error: 'email_required',
      message:
        'Enter your email to see your free risk score — it also verifies paid scans.',
    });
  }

  let entitlement;
  try {
    entitlement = await getEntitlement(email);
  } catch (err) {
    console.error('scan: entitlement lookup failed:', err && err.message);
    return res.status(500).json({
      error: 'entitlement_check_failed',
      message: 'We could not verify your scans. Please try again in a moment.',
    });
  }

  // PAID path: subscriber or credit holder gets the full report now.
  if (entitlement.subActive || entitlement.credits > 0) {
    const client = toClientReport(await analyzeContract(text));
    if (!entitlement.subActive && entitlement.customerId) {
      try {
        await decrementCredit(entitlement.customerId);
      } catch (err) {
        console.error('scan: credit decrement failed:', err && err.message);
      }
    }
    return res.status(200).json({
      demoMode: client.demoMode,
      score: client.score,
      summary: client.summary,
      flags: client.flags,
    });
  }

  // FREE path: one teaser per email. Claim FIRST (fail closed: no claim, no
  // teaser — and no wasted LLM call on a double-click or a Stripe outage),
  // then analyze and serve the teaser.
  let claim;
  try {
    claim = await withClaimLock(email, () => claimFreeScan(email));
  } catch (err) {
    console.error('scan: free teaser claim failed:', err && err.message);
    return res.status(502).json({
      error: 'teaser_claim_failed',
      message:
        'We could not start your free risk score right now. Please try again in a moment — you have not been charged and nothing was claimed.',
    });
  }

  if (claim.alreadyClaimed) {
    return res.status(403).json({
      error: 'teaser_already_claimed',
      message:
        'This email already claimed its free risk score. Unlock the full clause-by-clause report — every finding plus copy-paste pushback emails — for $5.',
      cta: { label: 'Unlock the full report — $5', price: 5 },
    });
  }

  let result;
  try {
    result = await analyzeContract(text);
  } catch (err) {
    console.error('scan: analysis failed after teaser claim:', err && err.message);
    return res.status(502).json({
      error: 'analysis_failed',
      message: 'The analysis hit a snag. Please try again in a moment.',
    });
  }

  let teaser;
  try {
    teaser = buildTeaser(toClientReport(result), email);
  } catch (err) {
    console.error('scan: teaser token sealing failed:', err && err.message);
    return res.status(502).json({
      error: 'teaser_claim_failed',
      message:
        'We could not start your free risk score right now. Please try again in a moment — you have not been charged and nothing was claimed.',
    });
  }

  return res.status(200).json(teaser);
};

// Test hook: reset the shared in-memory rate limiter between tests.
module.exports._resetRateLimits = _reset;
