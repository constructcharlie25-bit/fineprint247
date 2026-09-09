/**
 * lib/token.js — self-contained paid-unlock tokens.
 *
 * A paid unlock token carries the complete analyzed report in an encrypted,
 * HMAC-bound, time-limited token so that after a successful $5 Stripe
 * Checkout the client can retrieve the full report INSTANTLY — without a
 * second LLM call and without the server storing the report anywhere.
 *
 * Design:
 * - Envelope: fp1.<expMs>.<iv>.<ct+tag>.<mac>  (all base64url)
 * - Key derivation: HKDF-SHA256 from the existing STRIPE_WEBHOOK_SECRET.
 *   No new environment variable was introduced for this. Rationale: the
 *   webhook secret is a high-entropy, server-only secret already present in
 *   every environment where payments (and therefore unlock tokens) are
 *   live; deriving purpose-bound keys (HKDF with distinct info strings)
 *   keeps the token keys cryptographically isolated from the webhook
 *   signing key. Two consequences follow from this choice and are worth
 *   knowing:
 *     1. If STRIPE_WEBHOOK_SECRET is ever rotated, all outstanding unlock
 *        tokens are invalidated immediately (they fail HMAC verification).
 *        Paid users still get their report — /api/unlock falls back to a
 *        fresh paid re-analysis when the token is invalid.
 *     2. If STRIPE_WEBHOOK_SECRET is unset, tokens cannot be sealed; the
 *        free-teaser claim fails closed (502) instead of granting a teaser
 *        it could never unlock.
 * - AES-256-GCM encrypts the report; an outer HMAC-SHA256 (separate derived
 *   key) binds the version prefix, expiry, IV, and ciphertext so none can
 *   be tampered with. Expiry is checked only after MAC verification, so an
 *   attacker cannot extend a token's life.
 * - Tokens expire after 24 hours (UNLOCK_TTL_MS).
 * - The report (already full plain-English findings) is compressible text;
 *   even so, encrypted tokens larger than ~100KB (MAX_TOKEN_BYTES) are
 *   refused — sealUnlockToken returns { tooLarge: true } and the server
 *   falls back to a paid re-analysis after checkout instead of issuing a
 *   token. (A 100KB token is still small for sessionStorage, but at that
 *   size something unusual happened with the report, so the safe,
 *   documented fallback applies.)
 */
'use strict';

const crypto = require('crypto');

const TOKEN_VERSION = 'fp1';
const UNLOCK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TOKEN_BYTES = 100 * 1024; // ~100KB cap on the sealed token string

function deriveKey(purpose) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !secret.length) {
    const err = new Error('token_secret_missing');
    err.code = 'token_secret_missing';
    throw err;
  }
  // HKDF-SHA256: salt is a fixed zero block (the IKM already has full
  // entropy); the info string binds the derived key to this exact purpose.
  return crypto.hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf8'),
    Buffer.alloc(32, 0),
    `fineprint/unlock/v1/${purpose}`,
    32
  );
}

function b64u(buf) {
  return buf.toString('base64url');
}

/**
 * Seal a full report into an unlock token.
 * @param {object} report - the report object { demoMode, score, summary, flags }
 * @param {string} email - normalized email the token is bound to
 * @param {object} [opts] - { ttlMs } (tests use short TTLs)
 * @returns {{ token: string, expiresAt: string } | { tooLarge: true }}
 */
function sealUnlockToken(report, email, opts = {}) {
  const aesKey = deriveKey('aes');
  const macKey = deriveKey('hmac');
  const now = Date.now();
  const exp = now + (Number.isFinite(opts.ttlMs) ? opts.ttlMs : UNLOCK_TTL_MS);

  const inner = JSON.stringify({
    v: 1,
    email: String(email || ''),
    iat: now,
    exp,
    report,
  });

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([
    cipher.update(inner, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(), // 16-byte auth tag appended to the ciphertext
  ]);

  const body = `${b64u(iv)}.${b64u(ct)}`;
  const mac = crypto
    .createHmac('sha256', macKey)
    .update(`${TOKEN_VERSION}|${exp}|${body}`, 'utf8')
    .digest();

  const token = `${TOKEN_VERSION}.${exp}.${body}.${b64u(mac)}`;
  if (token.length > MAX_TOKEN_BYTES) {
    return { tooLarge: true };
  }
  return { token, expiresAt: new Date(exp).toISOString() };
}

/**
 * Open and verify an unlock token.
 * @returns {{ report: object, email: string, exp: number }}
 * @throws {Error} with message 'expired' or 'invalid'
 */
function openUnlockToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 5 || parts[0] !== TOKEN_VERSION) throw new Error('invalid');
    const [, expStr, ivB64, ctB64, macB64] = parts;
    const exp = Number(expStr);
    if (!Number.isFinite(exp)) throw new Error('invalid');

    // Verify the HMAC binding BEFORE trusting anything — including the
    // expiry timestamp itself.
    const body = `${ivB64}.${ctB64}`;
    const macKey = deriveKey('hmac');
    const expected = crypto
      .createHmac('sha256', macKey)
      .update(`${TOKEN_VERSION}|${exp}|${body}`, 'utf8')
      .digest();
    const actual = Buffer.from(macB64, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw new Error('invalid');
    }

    if (Date.now() > exp) throw new Error('expired');

    const iv = Buffer.from(ivB64, 'base64url');
    const ctAndTag = Buffer.from(ctB64, 'base64url');
    if (iv.length !== 12 || ctAndTag.length < 17) throw new Error('invalid');
    const ct = ctAndTag.subarray(0, -16);
    const tag = ctAndTag.subarray(-16);

    const aesKey = deriveKey('aes');
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);
    const inner = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');

    const payload = JSON.parse(inner);
    if (!payload || payload.v !== 1 || !payload.report || typeof payload.email !== 'string') {
      throw new Error('invalid');
    }
    return { report: payload.report, email: payload.email, exp: payload.exp };
  } catch (err) {
    if (err && (err.message === 'expired' || err.message === 'invalid')) throw err;
    throw new Error('invalid');
  }
}

module.exports = {
  sealUnlockToken,
  openUnlockToken,
  UNLOCK_TTL_MS,
  MAX_TOKEN_BYTES,
  TOKEN_VERSION,
};
