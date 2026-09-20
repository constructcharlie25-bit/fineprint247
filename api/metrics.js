/**
 * GET /api/metrics — read the aggregate funnel counters.
 *
 * Returns ONLY anonymous aggregate counts (free risk-score scans issued,
 * paid full-report unlocks confirmed by Stripe). No PII is stored or
 * returned — there is nothing personal to leak.
 *
 * With Vercel KV connected (KV_REST_API_URL / KV_REST_API_TOKEN set),
 * returns live counters:
 *   { "mode": "kv", "free_scans": 12, "paid_unlocks": 3 }
 *
 * Without KV, counters live in the Vercel runtime logs (one JSON line per
 * event); the response explains how to read them:
 *   { "mode": "log-fallback", "free_scans": null, "paid_unlocks": null,
 *     "how_to_read": "..." }
 */
'use strict';

const { kvConfig, funnelKey } = require('../lib/metrics');

async function kvMget(url, token, keys) {
  const resp = await fetch(
    url + '/mget/' + keys.map(encodeURIComponent).join('/'),
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!resp.ok) {
    throw new Error('kv_mget_failed: http ' + resp.status);
  }
  const data = await resp.json();
  return data && data.result;
}

function toCount(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const kv = kvConfig();
  if (!kv) {
    return res.status(200).json({
      mode: 'log-fallback',
      free_scans: null,
      paid_unlocks: null,
      how_to_read:
        'KV is not connected, so counts live in the Vercel runtime logs. ' +
        'In the Vercel dashboard open the fineprint247 project > Logs and ' +
        'filter for "fineprint-funnel". Each event is one JSON line: ' +
        '{"src":"fineprint-funnel","event":"free_scan"|"paid_unlock","ts":"..."}. ' +
        'Count lines per event value for the totals.',
    });
  }

  try {
    const result = await kvMget(kv.url, kv.token, [
      funnelKey('free_scan'),
      funnelKey('paid_unlock'),
    ]);
    return res.status(200).json({
      mode: 'kv',
      free_scans: toCount(result && result[0]),
      paid_unlocks: toCount(result && result[1]),
    });
  } catch (err) {
    console.error('metrics: kv read failed:', err && err.message);
    return res.status(502).json({ error: 'metrics_unavailable' });
  }
};
