/**
 * lib/ratelimit.js — tiny in-memory per-IP sliding-window rate limiter.
 *
 * BEST-EFFORT ON SERVERLESS: Vercel runs many function instances, each with
 * its own memory, so a determined abuser can spread requests across
 * instances. This stops casual abuse and accidental floods, which is all
 * the MVP needs. For strict global limits, use a shared store (e.g. Upstash
 * Redis) later.
 */
'use strict';

const buckets = new Map(); // key -> array of request timestamps (ms)

/**
 * Record a hit for `key`. Returns true if allowed, false if over the limit.
 * @param {string} key      e.g. `scan:1.2.3.4`
 * @param {number} limit    max requests per window
 * @param {number} windowMs window length in milliseconds
 */
function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  let hits = buckets.get(key);
  if (!hits) {
    hits = [];
    buckets.set(key, hits);
  }
  const cutoff = now - windowMs;
  while (hits.length && hits[0] <= cutoff) hits.shift();
  if (hits.length >= limit) return false;
  hits.push(now);
  // Keep the map from growing unboundedly across many distinct IPs.
  if (buckets.size > 10000) buckets.clear();
  return true;
}

/** Best-effort client IP: respects Vercel's x-forwarded-for header. */
function clientIp(req) {
  const headers = (req && req.headers) || {};
  const fwd = headers['x-forwarded-for'] || headers['x-real-ip'];
  if (fwd) return String(fwd).split(',')[0].trim();
  if (req && req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  return 'unknown';
}

/** Test-only: clear all buckets. */
function _reset() {
  buckets.clear();
}

module.exports = { checkRateLimit, clientIp, _reset };
