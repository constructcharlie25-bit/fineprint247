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
 *     "flags": [{ "title", "clause", "risk", "explanation", "suggestion" }] }
 *
 * Payments (when STRIPE_SECRET_KEY is set):
 *   - `email` is required (400 email_required if missing/invalid).
 *   - The buyer must have an active subscription or remaining single-scan
 *     credits (402 payment_required otherwise).
 *   - Non-subscribers spend one credit per successful scan; subscribers scan
 *     free. Entitlements live on the Stripe Customer (lib/entitlements.js).
 *
 * Demo mode: when no LLM key env var is set, returns a realistic canned
 * analysis so the full UI flow works without any key or spend. When Stripe
 * is not configured either, scans are free during the beta (email optional).
 */
'use strict';

const { analyzeContract, extractText } = require('../lib/analysis');
const { getStripe } = require('../lib/stripe');
const {
  isValidEmail,
  normalizeEmail,
  getEntitlement,
  decrementCredit,
} = require('../lib/entitlements');
const { checkRateLimit, clientIp, _reset } = require('../lib/ratelimit');

const MAX_TEXT_CHARS = 100000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// 20 scans per 10 minutes per IP (best-effort, in-memory — see lib/ratelimit.js).
const SCAN_LIMIT = 20;
const SCAN_WINDOW_MS = 10 * 60 * 1000;

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

    // --- Entitlement gate (only when payments are live) ---
    const paymentsLive = !!getStripe();
    let entitlement = null;
    if (paymentsLive) {
      if (!isValidEmail(email)) {
        return res.status(400).json({
          error: 'email_required',
          message: 'Enter the email you used at checkout so we can verify your scans.',
        });
      }
      try {
        entitlement = await getEntitlement(email);
      } catch (err) {
        console.error('scan: entitlement lookup failed:', err && err.message);
        return res.status(500).json({
          error: 'entitlement_check_failed',
          message: 'Could not verify your purchase. Please try again.',
        });
      }
      if (!entitlement.subActive && entitlement.credits <= 0) {
        return res.status(402).json({
          error: 'payment_required',
          message: "You're out of scans. Buy another scan or go unlimited to continue.",
        });
      }
    }

    // --- Input parsing (unchanged) ---
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

    const result = await analyzeContract(text);

    // --- Spend one credit for non-subscribers (only when payments are live) ---
    if (paymentsLive && entitlement && !entitlement.subActive && entitlement.customerId) {
      try {
        await decrementCredit(entitlement.customerId);
      } catch (err) {
        // The scan already succeeded — log, don't fail the response.
        console.error('scan: credit decrement failed:', err && err.message);
      }
    }

    return res.status(200).json(result);
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
