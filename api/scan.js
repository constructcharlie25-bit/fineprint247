/**
 * POST /api/scan — analyze a contract and return a risk report.
 *
 * Body (JSON):
 *   { "text": "<pasted contract text>", "email": "you@example.com" }
 *   or
 *   { "fileBase64": "<base64 file bytes>", "filename": "agreement.pdf", "email": "..." }
 *     (.pdf, .docx, .txt — max ~4MB)
 *   `email` may also be passed as a query param (?email=...).
 *
 * Response (JSON):
 *   { "demoMode": true|false, "score": 0-100, "summary": "...",
 *     "flags": [{ "title", "clause", "risk", "explanation", "suggestion",
 *                 "negotiationEmail" (high-risk flags only) }] }
 *
 *   Free-tier gate: the response may instead be a GATED partial report:
 *     { "gated": true, "gateReason": "no_email" | "free_used",
 *       "score", "summary", "flags": [<top flag only>],
 *       "gatedCount": <number of remaining hidden flags> }
 *   "no_email":  scan ran fine, but enter an email to unlock the full report.
 *   "free_used": that email already claimed its one free scan — buy to continue.
 *
 * Payments (when STRIPE_SECRET_KEY is set):
 *   - Everyone sees the risk score + top flag free (the "aha").
 *   - `email` unlocks the full report. First scan per email is free: the
 *     free claim is recorded as fp_free_used="1" on the Stripe Customer
 *     (lib/entitlements.js), no card required.
 *   - After the free scan, the buyer needs an active subscription or
 *     remaining single-scan credits (previously 402 payment_required; now
 *     the gated report with gateReason "free_used" is returned instead,
 *     and the frontend shows the buy CTA).
 *   - Non-subscribers spend one credit per successful full-report scan;
 *     subscribers scan free. Entitlements live on the Stripe Customer.
 *
 * Demo mode: when no LLM key env var is set, returns a realistic canned
 * analysis so the full UI flow works without any key or spend. When Stripe
 * is not configured either, scans are free during the beta (email optional,
 * full report ungated).
 */
'use strict';

const crypto = require('crypto');
const { analyzeContract, extractText } = require('../lib/analysis');
const { getStripe } = require('../lib/stripe');
const {
  isValidEmail,
  normalizeEmail,
  getEntitlement,
  decrementCredit,
  claimFreeScan,
} = require('../lib/entitlements');
const { checkRateLimit, clientIp, _reset } = require('../lib/ratelimit');

const MAX_TEXT_CHARS = 100000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// 20 scans per 10 minutes per IP (best-effort, in-memory — see lib/ratelimit.js).
const SCAN_LIMIT = 20;
const SCAN_WINDOW_MS = 10 * 60 * 1000;

/**
 * Per-email in-flight lock for the free-scan claim. Two simultaneous
 * "Scan" clicks from the same email are serialized so the second sees the
 * first's fp_free_used write and gets the gated report instead of a second
 * free scan. Best-effort per instance (see claimFreeScan's race note).
 */
const claimLocks = new Map();
async function withClaimLock(email, fn) {
  const prev = claimLocks.get(email) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  claimLocks.set(email, current);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (claimLocks.get(email) === current) claimLocks.delete(email);
  }
}

/**
 * Small in-process analysis cache keyed by a hash of the contract text.
 * Why: the free funnel does two passes over the same text (anonymous gated
 * preview, then the email unlock). Re-analyzing would double the LLM cost per
 * free scan AND could show a different score than the preview promised.
 * The frontend resubmits the same text on unlock, so the cache key matches.
 * Best-effort on serverless (per-instance), bounded to 200 entries.
 */
const analysisCache = new Map(); // hash -> { at, result }
const ANALYSIS_CACHE_TTL_MS = 30 * 60 * 1000;
const ANALYSIS_CACHE_MAX = 200;

function hashText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

async function analyzeWithCache(text) {
  const key = hashText(text);
  const hit = analysisCache.get(key);
  if (hit && Date.now() - hit.at < ANALYSIS_CACHE_TTL_MS) {
    // Refresh recency; return a copy so callers can annotate freely.
    analysisCache.delete(key);
    analysisCache.set(key, hit);
    return { ...hit.result };
  }
  const result = await analyzeContract(text);
  analysisCache.set(key, { at: Date.now(), result });
  if (analysisCache.size > ANALYSIS_CACHE_MAX) {
    analysisCache.delete(analysisCache.keys().next().value);
  }
  return { ...result };
}

/** Build the gated partial report: score + summary + top flag only. */
function gatedReport(result, gateReason) {
  const flags = Array.isArray(result.flags) ? result.flags : [];
  return {
    demoMode: !!result.demoMode,
    gated: true,
    gateReason,
    score: result.score,
    summary: result.summary,
    flags: flags.slice(0, 1),
    gatedCount: Math.max(0, flags.length - 1),
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
      message: 'Too many scans. Please wait a few minutes and try again.',
    });
  }

  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email || (req.query && req.query.email) || '');
    const paymentsLive = !!getStripe();

    // --- Input parsing first: never touch Stripe for garbage input ---
    let text = '';
    if (typeof body.text === 'string' && body.text.trim()) {
      text = body.text;
    } else if (body.fileBase64 && body.filename) {
      const buffer = Buffer.from(String(body.fileBase64), 'base64');
      if (buffer.length > MAX_FILE_BYTES) {
        return res.status(413).json({ error: 'file_too_large', message: 'File must be under 4MB.' });
      }
      try {
        text = await extractText(buffer, String(body.filename));
      } catch (e) {
        if (e && e.code === 'unsupported_file') {
          return res.status(400).json({ error: 'unsupported_file', message: 'Please upload a PDF, DOCX, or TXT file.' });
        }
        return res.status(422).json({ error: 'could_not_parse_file', message: 'We could not read that file. Try copy-pasting the text instead.' });
      }
    } else {
      return res.status(400).json({ error: 'no_input', message: 'Paste contract text or upload a file.' });
    }

    text = text.trim();
    if (text.length < 50) {
      return res.status(400).json({ error: 'text_too_short', message: 'Please provide more contract text (at least a few sentences).' });
    }
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);

    const result = await analyzeWithCache(text);

    // --- Entitlement / free-tier gate (only when payments are live) ---
    // Everyone sees the score + top flag. Email unlocks the full report:
    // the first scan per email is free (fp_free_used on the Customer),
    // after that it's credits or a subscription.
    if (!paymentsLive) {
      return res.status(200).json(result);
    }

    if (!isValidEmail(email)) {
      return res.status(200).json(gatedReport(result, 'no_email'));
    }

    let entitlement;
    try {
      entitlement = await getEntitlement(email);
    } catch (err) {
      console.error('scan: entitlement lookup failed:', err && err.message);
      return res.status(500).json({
        error: 'entitlement_check_failed',
        message: 'Could not verify your purchase. Please try again.',
      });
    }

    if (entitlement.subActive || entitlement.credits > 0) {
      // Paid path — unchanged: full report, spend one credit for non-subscribers.
      if (!entitlement.subActive && entitlement.customerId) {
        try {
          await decrementCredit(entitlement.customerId);
        } catch (err) {
          // The scan already succeeded — log, don't fail the response.
          console.error('scan: credit decrement failed:', err && err.message);
        }
      }
      return res.status(200).json(result);
    }

    // Free-tier claim: one full report per email, no card.
    const claim = await withClaimLock(email, async () => {
      try {
        return await claimFreeScan(email);
      } catch (err) {
        console.error('scan: free-scan claim failed:', err && err.message);
        return { failed: true };
      }
    });
    if (claim.failed) {
      return res.status(502).json({
        error: 'free_scan_failed',
        message: 'Could not start your free scan. Please try again.',
      });
    }
    if (claim.alreadyClaimed) {
      return res.status(200).json(gatedReport(result, 'free_used'));
    }
    return res.status(200).json({ ...result, freeScan: true });
  } catch (err) {
    if (err && err.message === 'llm_error') {
      return res.status(502).json({ error: 'analysis_failed', message: 'The analysis service is unavailable right now. Please try again.' });
    }
    if (err && err.message === 'bad_response') {
      return res.status(502).json({ error: 'analysis_failed', message: 'The analysis came back unreadable. Please try again.' });
    }
    console.error('scan error:', err);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
};

// Test-only hook (see test/test-api.js).
module.exports._resetRateLimits = _reset;
