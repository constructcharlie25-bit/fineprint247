/**
 * test/test-api.js — exercise the API routes with mocked req/res.
 * Run: npm test   (runs in demo mode: no LLM key needed)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

delete process.env.LLM_API_KEY; // force demo mode

const scan = require('../api/scan');
const sample = require('../api/sample');
const checkout = require('../api/checkout');
const waitlist = require('../api/waitlist');
const { extractText, validateAnalysis, buildSystemPrompt, DEMO_ANALYSIS } = require('../lib/analysis');

function mockReq({ method = 'POST', body = {}, headers = {} } = {}) {
  return { method, body, headers };
}
function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { res.headers[k] = v; },
    status(c) { res.statusCode = c; return res; },
    json(o) { res.body = o; return res; },
  };
  return res;
}

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok -', name);
  } catch (e) {
    console.error('  FAIL -', name);
    console.error('        ', e.message);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('scan route (demo mode)');
  await t('POST text -> 200 with valid demo report', async () => {
    const req = mockReq({ body: { text: 'This is a services agreement between Client and Contractor for design work. '.repeat(10) } });
    const res = mockRes();
    await scan(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.demoMode, true);
    assert.strictEqual(res.body.score, DEMO_ANALYSIS.score);
    assert.ok(typeof res.body.summary === 'string' && res.body.summary.length > 20);
    assert.ok(Array.isArray(res.body.flags) && res.body.flags.length > 0);
    for (const f of res.body.flags) {
      assert.ok(f.title && f.clause && f.explanation && f.suggestion, 'flag missing field');
      assert.ok(['high', 'medium', 'low'].includes(f.risk), 'bad risk value');
    }
  });

  await t('POST empty body -> 400 no_input', async () => {
    const res = mockRes();
    await scan(mockReq({ body: {} }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'no_input');
  });

  await t('POST tiny text -> 400 text_too_short', async () => {
    const res = mockRes();
    await scan(mockReq({ body: { text: 'hi' } }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'text_too_short');
  });

  await t('GET -> 405', async () => {
    const res = mockRes();
    await scan(mockReq({ method: 'GET' }), res);
    assert.strictEqual(res.statusCode, 405);
  });

  await t('POST txt file -> 200', async () => {
    const b64 = Buffer.from('Contract text here. '.repeat(20)).toString('base64');
    const res = mockRes();
    await scan(mockReq({ body: { fileBase64: b64, filename: 'agreement.txt' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.demoMode, true);
  });

  await t('POST garbage pdf -> 422 could_not_parse_file', async () => {
    const b64 = Buffer.from('this is not a pdf at all, just some bytes').toString('base64');
    const res = mockRes();
    await scan(mockReq({ body: { fileBase64: b64, filename: 'agreement.pdf' } }), res);
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(res.body.error, 'could_not_parse_file');
  });

  await t('POST .png -> 400 unsupported_file', async () => {
    const b64 = Buffer.from('fake image bytes').toString('base64');
    const res = mockRes();
    await scan(mockReq({ body: { fileBase64: b64, filename: 'pic.png' } }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'unsupported_file');
  });

  console.log('extractText');
  await t('parses the fixture PDF (real-world sample)', async () => {
    const buf = fs.readFileSync(path.join(__dirname, 'contract.pdf'));
    const text = await extractText(buf, 'contract.pdf');
    assert.ok(text.toLowerCase().includes('dummy pdf'), 'pdf text missing, got: ' + text.slice(0, 80));
  });

  await t('parses the fixture DOCX', async () => {
    const buf = fs.readFileSync(path.join(__dirname, 'contract.docx'));
    const text = await extractText(buf, 'contract.docx');
    assert.ok(text.toLowerCase().includes('intellectual property'), 'docx text missing, got: ' + text.slice(0, 80));
  });

  await t('rejects unsupported extensions', async () => {
    await assert.rejects(extractText(Buffer.from('x'), 'a.png'), /unsupported_file/);
  });

  console.log('other routes');
  await t('GET /api/sample -> 200 with text', async () => {
    const res = mockRes();
    await sample(mockReq({ method: 'GET' }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.text.includes('INDEPENDENT CONTRACTOR AGREEMENT'));
  });

  await t('POST /api/checkout (no key) -> 501 stub', async () => {
    const res = mockRes();
    await checkout(mockReq({ body: { mode: 'single' } }), res);
    assert.strictEqual(res.statusCode, 501);
    assert.strictEqual(res.body.error, 'payments_not_configured');
  });

  await t('POST /api/waitlist valid email -> 200', async () => {
    const res = mockRes();
    await waitlist(mockReq({ body: { email: 'Tester@Example.com' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
  });

  await t('POST /api/waitlist bad email -> 400', async () => {
    const res = mockRes();
    await waitlist(mockReq({ body: { email: 'not-an-email' } }), res);
    assert.strictEqual(res.statusCode, 400);
  });

  console.log('analysis helpers');
  await t('system prompt demands JSON-only output', async () => {
    const p = buildSystemPrompt();
    assert.ok(p.includes('ONLY valid JSON'));
    assert.ok(p.includes('"flags"'));
    assert.ok(p.toLowerCase().includes('not legal advice') || p.includes('NOT as legal advice'));
  });

  await t('validateAnalysis clamps and sorts flags', async () => {
    const out = validateAnalysis({
      score: 250,
      summary: 'x',
      flags: [
        { title: 'a', clause: 'c1', risk: 'low', explanation: 'e', suggestion: 's' },
        { title: 'b', clause: 'c2', risk: 'high', explanation: 'e', suggestion: 's' },
        { title: 'c', clause: '', risk: 'high', explanation: 'e', suggestion: 's' },
      ],
    });
    assert.strictEqual(out.score, 100);
    assert.strictEqual(out.flags.length, 2);
    assert.strictEqual(out.flags[0].risk, 'high');
  });

  console.log(`\n${passed} tests passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
})();
