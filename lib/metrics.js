/**
 * lib/metrics.js — privacy-friendly aggregate funnel counters.
 *
 * Purpose: learn where the FinePrint funnel breaks
 * (visitors -> free risk-score scans -> paid full reports) without
 * collecting anything personal.
 *
 * Events counted (aggregate counts ONLY — no PII, no cookies, no
 * fingerprinting, no contract text, no emails, no IPs):
 *   free_scan   — a free risk-score teaser was issued (api/scan.js)
 *   paid_unlock — Stripe confirmed a payment that grants full-report
 *                 access: a $5 report purchase OR a new $29/mo subscription
 *                 (api/webhook.js, checkout.session.completed)
 *
 * Persistence:
 * - Preferred: Vercel KV. When the KV_REST_API_URL and KV_REST_API_TOKEN
 *   env vars are present (added automatically when a KV store is connected
 *   to the project in the Vercel dashboard), counters are incremented
 *   atomically via the Upstash REST API and readable at GET /api/metrics.
 * - Fallback: one structured log line per event. Vercel retains runtime
 *   logs, so counts can be tallied by filtering logs for "fineprint-funnel".
 *   The deploy is never blocked waiting on KV provisioning.
 *
 * Safety: countFunnelEvent() NEVER throws. Metrics must not break the
 * revenue path — a failed count degrades to a log line, and a failed log
 * is swallowed.
 */
'use strict';

const FUNNEL_EVENTS = new Set(['free_scan', 'paid_unlock']);
const KEY_PREFIX = 'fineprint:funnel:';
const LOG_SRC = 'fineprint-funnel';

function funnelKey(event) {
  return KEY_PREFIX + event;
}

function kvConfig() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (url && token) {
    return { url: String(url).replace(/\/+$/, ''), token: String(token) };
  }
  return null;
}

/** Atomic increment via the Upstash (Vercel KV) REST API. */
async function kvIncr(url, token, key) {
  const resp = await fetch(url + '/incr/' + encodeURIComponent(key), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!resp.ok) {
    throw new Error('kv_incr_failed: http ' + resp.status);
  }
  const data = await resp.json();
  return data && data.result;
}

/** One marker log line per event — the no-KV fallback. */
function logEvent(event) {
  console.log(
    JSON.stringify({ src: LOG_SRC, event, ts: new Date().toISOString() })
  );
}

/**
 * Record one funnel event. Fire-and-forget safe: the returned promise
 * never rejects, so callers may await it or not.
 */
async function countFunnelEvent(event) {
  try {
    if (!FUNNEL_EVENTS.has(event)) return;
    const kv = kvConfig();
    if (kv) {
      try {
        await kvIncr(kv.url, kv.token, funnelKey(event));
        return;
      } catch (err) {
        // KV hiccup: still record the event in the logs rather than
        // dropping it silently.
      }
    }
    logEvent(event);
  } catch (err) {
    // Absolute last resort — never let metrics break the request.
  }
}

module.exports = {
  countFunnelEvent,
  funnelKey,
  kvConfig,
  FUNNEL_EVENTS,
  LOG_SRC,
  // Test hooks (not part of the public surface):
  _kvIncr: kvIncr,
  _logEvent: logEvent,
};
