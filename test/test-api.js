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
const tiers = require('../api/tiers');
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

  await t('POST /api/tiers -> 200 reflects STRIPE_PRICE_PACK', async () => {
    const saved = saveEnv();
    try {
      delete process.env.STRIPE_PRICE_PACK;
      let res = mockRes();
      await tiers(mockReq({ method: 'GET' }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(res.body.tiers, { single: true, pack: false, subscription: true });

      process.env.STRIPE_PRICE_PACK = 'price_pack_789';
      res = mockRes();
      await tiers(mockReq({ method: 'GET' }), res);
      assert.strictEqual(res.body.tiers.pack, true);
    } finally { restoreEnv(saved); }
  });

  await t('POST /api/tiers -> 405', async () => {
    const res = mockRes();
    await tiers(mockReq({ method: 'POST' }), res);
    assert.strictEqual(res.statusCode, 405);
  });

  console.log('analysis helpers');
  await t('system prompt demands JSON-only output', async () => {
    const p = buildSystemPrompt();
    assert.ok(p.includes('ONLY valid JSON'));
    assert.ok(p.includes('"flags"'));
    assert.ok(p.toLowerCase().includes('not legal advice') || p.includes('NOT as legal advice'));
  });

  await t('system prompt asks for negotiationEmail on high-risk flags', async () => {
    const p = buildSystemPrompt();
    assert.ok(p.includes('negotiationEmail'));
    assert.ok(p.includes('THE CLIENT'));
    assert.ok(p.includes('[BRACKETED PLACEHOLDERS]'));
  });

  await t('validateAnalysis keeps negotiationEmail for high flags, drops for others', async () => {
    const out = validateAnalysis({
      score: 80,
      summary: 'x',
      flags: [
        { title: 'h', clause: 'c1', risk: 'high', explanation: 'e', suggestion: 's', negotiationEmail: 'Hi [Name], please fix this.' },
        { title: 'm', clause: 'c2', risk: 'medium', explanation: 'e', suggestion: 's', negotiationEmail: 'should be dropped' },
        { title: 'l', clause: 'c3', risk: 'low', explanation: 'e', suggestion: 's' },
      ],
    });
    assert.strictEqual(out.flags[0].negotiationEmail, 'Hi [Name], please fix this.');
    assert.strictEqual(out.flags[1].negotiationEmail, '');
    assert.strictEqual(out.flags[2].negotiationEmail, '');
  });

  await t('DEMO_ANALYSIS: every high flag has a pushback email with placeholders', async () => {
    const highs = DEMO_ANALYSIS.flags.filter((f) => f.risk === 'high');
    assert.ok(highs.length >= 5, 'expected several demo high flags, got ' + highs.length);
    for (const f of highs) {
      assert.ok(f.negotiationEmail && f.negotiationEmail.length > 40, 'missing email for: ' + f.title);
      assert.ok(f.negotiationEmail.includes('[') && f.negotiationEmail.includes(']'), 'no [placeholders] in: ' + f.title);
      assert.ok(/subject:/i.test(f.negotiationEmail), 'no subject line in: ' + f.title);
    }
    for (const f of DEMO_ANALYSIS.flags.filter((f) => f.risk !== 'high')) {
      assert.ok(!f.negotiationEmail, 'non-high flag should not carry an email: ' + f.title);
    }
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

  console.log('stripe helpers + rate limiter');
  await t('ratelimit: allows up to the limit, then blocks', async () => {
    const { checkRateLimit, _reset } = require('../lib/ratelimit');
    _reset();
    assert.strictEqual(checkRateLimit('k1', 3, 60000), true);
    assert.strictEqual(checkRateLimit('k1', 3, 60000), true);
    assert.strictEqual(checkRateLimit('k1', 3, 60000), true);
    assert.strictEqual(checkRateLimit('k1', 3, 60000), false);
    _reset();
    assert.strictEqual(checkRateLimit('k1', 3, 60000), true);
  });

  await t('ratelimit: clientIp reads x-forwarded-for', async () => {
    const { clientIp } = require('../lib/ratelimit');
    assert.strictEqual(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '1.2.3.4');
    assert.strictEqual(clientIp({ headers: {} }), 'unknown');
    assert.strictEqual(clientIp(null), 'unknown');
  });

  /* ---------------- mock-stripe harness ---------------- */
  const { Readable } = require('stream');
  const stripePath = require.resolve('stripe');
  const realStripeEntry = require.cache[stripePath];
  function mockStripe(factory) {
    require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: factory };
  }
  function unmockStripe() {
    if (realStripeEntry) require.cache[stripePath] = realStripeEntry;
    else delete require.cache[stripePath];
  }
  // In-memory fake Stripe: db maps email -> { id, metadata }.
  function makeFakeStripe(db) {
    function factory() {
      return {
        customers: {
          list: async ({ email }) => ({
            data: db[email] ? [{ id: db[email].id, email, metadata: { ...db[email].metadata } }] : [],
          }),
          create: async ({ email }) => {
            const id = 'cus_test_' + Math.random().toString(36).slice(2, 10);
            db[email] = { id, metadata: {} };
            return { id, email, metadata: {} };
          },
          retrieve: async (id) => {
            const e = Object.keys(db).find((k) => db[k].id === id);
            if (!e) throw Object.assign(new Error('No such customer'), { statusCode: 404 });
            return { id, email: e, metadata: { ...db[e].metadata } };
          },
          update: async (id, params) => {
            const e = Object.keys(db).find((k) => db[k].id === id);
            if (!e) throw new Error('No such customer');
            db[e].metadata = { ...(params.metadata || {}) };
            return { id, metadata: { ...db[e].metadata } };
          },
        },
        checkout: {
          sessions: {
            create: async (params) => {
              factory.lastCreate = params;
              return { id: 'cs_test_1', url: 'https://checkout.stripe.test/pay/cs_test_1' };
            },
          },
        },
        webhooks: {
          constructEvent: (raw, sig, secret) => {
            if (sig !== 'sig_valid' || secret !== 'whsec_test') {
              throw Object.assign(new Error('bad signature'), { type: 'StripeSignatureVerificationError' });
            }
            return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
          },
        },
      };
    }
    factory.lastCreate = null;
    return factory;
  }
  function streamReq(payload, headers) {
    const r = Readable.from([Buffer.from(payload)]);
    r.method = 'POST';
    r.headers = headers || {};
    return r;
  }
  function saveEnv() {
    return {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
      STRIPE_PRICE_SINGLE: process.env.STRIPE_PRICE_SINGLE,
      STRIPE_PRICE_MONTHLY: process.env.STRIPE_PRICE_MONTHLY,
      APP_URL: process.env.APP_URL,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      OPENAI_MODEL: process.env.OPENAI_MODEL,
    };
  }
  function restoreEnv(saved) {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  /* ---------------- /api/checkout (live) ---------------- */
  console.log('checkout route (mocked stripe)');
  await t('POST single -> 200 with checkout url + correct session params', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_PRICE_SINGLE = 'price_single_123';
    process.env.STRIPE_PRICE_MONTHLY = 'price_monthly_456';
    process.env.APP_URL = 'https://fineprint247.com';
    const factory = makeFakeStripe({});
    mockStripe(factory);
    try {
      const res = mockRes();
      await checkout(mockReq({ body: { mode: 'single', email: 'Buyer@Example.com' } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.url, 'https://checkout.stripe.test/pay/cs_test_1');
      const p = factory.lastCreate;
      assert.strictEqual(p.mode, 'payment');
      assert.strictEqual(p.line_items[0].price, 'price_single_123');
      assert.ok(/^cus_test_/.test(p.customer), 'session uses a real customer id, not a guest: ' + p.customer);
      assert.strictEqual(p.client_reference_id, 'buyer@example.com');
      assert.ok(p.success_url.includes('/scan.html?paid=1&email=buyer%40example.com'), p.success_url);
      assert.ok(p.cancel_url.endsWith('/#pricing'), p.cancel_url);
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('POST subscription -> recurring mode + monthly price', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_PRICE_SINGLE = 'price_single_123';
    process.env.STRIPE_PRICE_MONTHLY = 'price_monthly_456';
    process.env.APP_URL = 'https://fineprint247.com';
    const factory = makeFakeStripe({});
    mockStripe(factory);
    try {
      const res = mockRes();
      await checkout(mockReq({ body: { mode: 'subscription', email: 'sub@example.com' } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(factory.lastCreate.mode, 'subscription');
      assert.strictEqual(factory.lastCreate.line_items[0].price, 'price_monthly_456');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('POST checkout bad email -> 400', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    mockStripe(makeFakeStripe({}));
    try {
      const res = mockRes();
      await checkout(mockReq({ body: { mode: 'single', email: 'nope' } }), res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.error, 'bad_email');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('POST checkout bad mode -> 400', async () => {
    const res = mockRes();
    await checkout(mockReq({ body: { mode: 'yearly', email: 'a@b.co' } }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'bad_mode');
  });

  await t('POST checkout pack -> 200, monthly price + 5-credit grant metadata', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_PRICE_SINGLE = 'price_single_123';
    process.env.STRIPE_PRICE_PACK = 'price_pack_789';
    process.env.STRIPE_PRICE_MONTHLY = 'price_monthly_456';
    process.env.APP_URL = 'https://fineprint247.com';
    const factory = makeFakeStripe({});
    mockStripe(factory);
    try {
      const res = mockRes();
      await checkout(mockReq({ body: { mode: 'pack', email: 'pack@example.com' } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.url, 'https://checkout.stripe.test/pay/cs_test_1');
      const p = factory.lastCreate;
      assert.strictEqual(p.mode, 'payment');
      assert.strictEqual(p.line_items[0].price, 'price_pack_789');
      assert.strictEqual(p.metadata.fp_credits_grant, '5');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('POST checkout pack without STRIPE_PRICE_PACK -> 500 payments_misconfigured', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_PRICE_SINGLE = 'price_single_123';
    process.env.STRIPE_PRICE_MONTHLY = 'price_monthly_456';
    delete process.env.STRIPE_PRICE_PACK;
    mockStripe(makeFakeStripe({}));
    try {
      const res = mockRes();
      await checkout(mockReq({ body: { mode: 'pack', email: 'a@b.co' } }), res);
      assert.strictEqual(res.statusCode, 500);
      assert.strictEqual(res.body.error, 'payments_misconfigured');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('POST checkout single carries 1-credit grant metadata', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_PRICE_SINGLE = 'price_single_123';
    process.env.STRIPE_PRICE_MONTHLY = 'price_monthly_456';
    process.env.APP_URL = 'https://fineprint247.com';
    const factory = makeFakeStripe({});
    mockStripe(factory);
    try {
      const res = mockRes();
      await checkout(mockReq({ body: { mode: 'single', email: 's@example.com' } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(factory.lastCreate.metadata.fp_credits_grant, '1');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('POST checkout missing price env -> 500 payments_misconfigured', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    delete process.env.STRIPE_PRICE_SINGLE;
    delete process.env.STRIPE_PRICE_MONTHLY;
    mockStripe(makeFakeStripe({}));
    try {
      const res = mockRes();
      await checkout(mockReq({ body: { mode: 'single', email: 'a@b.co' } }), res);
      assert.strictEqual(res.statusCode, 500);
      assert.strictEqual(res.body.error, 'payments_misconfigured');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  /* ---------------- lib/entitlements ---------------- */
  console.log('entitlements');
  await t('getEntitlement parses credits + sub flag', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const db = { 'pro@example.com': { id: 'cus_1', metadata: { fp_credits: '3', fp_sub_active: 'true' } } };
    mockStripe(makeFakeStripe(db));
    try {
      const { getEntitlement } = require('../lib/entitlements');
      const e = await getEntitlement('PRO@example.com');
      assert.deepStrictEqual(e, { credits: 3, subActive: true, customerId: 'cus_1' });
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('getEntitlement unknown customer -> zeros', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    mockStripe(makeFakeStripe({}));
    try {
      const { getEntitlement } = require('../lib/entitlements');
      const e = await getEntitlement('nobody@example.com');
      assert.deepStrictEqual(e, { credits: 0, subActive: false, customerId: null });
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('getEntitlement with no stripe key -> zeros (no crash)', async () => {
    const saved = saveEnv();
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const { getEntitlement } = require('../lib/entitlements');
      const e = await getEntitlement('x@y.co');
      assert.deepStrictEqual(e, { credits: 0, subActive: false, customerId: null });
    } finally { restoreEnv(saved); }
  });

  await t('decrementCredit decrements and floors at 0', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const db = {
      'a@example.com': { id: 'cus_a', metadata: { fp_credits: '2', fp_sub_active: 'false' } },
      'b@example.com': { id: 'cus_b', metadata: { fp_credits: '0' } },
    };
    mockStripe(makeFakeStripe(db));
    try {
      const { decrementCredit } = require('../lib/entitlements');
      assert.strictEqual(await decrementCredit('cus_a'), 1);
      assert.strictEqual(db['a@example.com'].metadata.fp_credits, '1');
      assert.strictEqual(await decrementCredit('cus_b'), 0);
      assert.strictEqual(db['b@example.com'].metadata.fp_credits, '0');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('isValidEmail accepts good, rejects bad', async () => {
    const { isValidEmail } = require('../lib/entitlements');
    assert.strictEqual(isValidEmail('a@b.co'), true);
    assert.strictEqual(isValidEmail('  A@B.CO  '), true);
    assert.strictEqual(isValidEmail('nope'), false);
    assert.strictEqual(isValidEmail(''), false);
    assert.strictEqual(isValidEmail(null), false);
  });

  /* ---------------- /api/webhook (mocked stripe) ---------------- */
  console.log('webhook route (mocked stripe)');
  const webhook = require('../api/webhook');

  await t('POST webhook without secrets -> 501', async () => {
    const saved = saveEnv();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const res = mockRes();
      await webhook(streamReq('{}', { 'stripe-signature': 'x' }), res);
      assert.strictEqual(res.statusCode, 501);
    } finally { restoreEnv(saved); }
  });

  await t('POST webhook bad signature -> 400', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    mockStripe(makeFakeStripe({}));
    try {
      const res = mockRes();
      await webhook(streamReq('{"type":"ping"}', { 'stripe-signature': 'sig_wrong' }), res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.error, 'bad_signature');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('checkout.session.completed (payment) grants +1 credit', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const db = { 'buyer@example.com': { id: 'cus_9', metadata: { fp_credits: '1' } } };
    mockStripe(makeFakeStripe(db));
    try {
      const event = {
        id: 'evt_1', type: 'checkout.session.completed',
        data: { object: { id: 'cs_1', mode: 'payment', customer: 'cus_9', customer_email: 'buyer@example.com' } },
      };
      const res = mockRes();
      await webhook(streamReq(JSON.stringify(event), { 'stripe-signature': 'sig_valid' }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(db['buyer@example.com'].metadata.fp_credits, '2');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('checkout.session.completed (pack) grants +5 credits from session metadata', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const db = { 'pack@example.com': { id: 'cus_10', metadata: { fp_credits: '0' } } };
    mockStripe(makeFakeStripe(db));
    try {
      const event = {
        id: 'evt_1b', type: 'checkout.session.completed',
        data: { object: { id: 'cs_9', mode: 'payment', customer: 'cus_10', metadata: { fp_credits_grant: '5' } } },
      };
      const res = mockRes();
      await webhook(streamReq(JSON.stringify(event), { 'stripe-signature': 'sig_valid' }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(db['pack@example.com'].metadata.fp_credits, '5');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('checkout.session.completed (payment) with bad grant metadata defaults to +1', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const db = { 'buyer@example.com': { id: 'cus_9', metadata: { fp_credits: '0' } } };
    mockStripe(makeFakeStripe(db));
    try {
      const event = {
        id: 'evt_1c', type: 'checkout.session.completed',
        data: { object: { id: 'cs_8', mode: 'payment', customer: 'cus_9', metadata: { fp_credits_grant: 'junk' } } },
      };
      const res = mockRes();
      await webhook(streamReq(JSON.stringify(event), { 'stripe-signature': 'sig_valid' }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(db['buyer@example.com'].metadata.fp_credits, '1');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('checkout.session.completed (subscription) activates sub', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const db = { 'sub@example.com': { id: 'cus_8', metadata: { fp_sub_active: 'false' } } };
    mockStripe(makeFakeStripe(db));
    try {
      const event = {
        id: 'evt_2', type: 'checkout.session.completed',
        data: { object: { id: 'cs_2', mode: 'subscription', customer: 'cus_8' } },
      };
      const res = mockRes();
      await webhook(streamReq(JSON.stringify(event), { 'stripe-signature': 'sig_valid' }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(db['sub@example.com'].metadata.fp_sub_active, 'true');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('customer.subscription.updated reflects status (trialing->true, past_due->false)', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const db = { 's@example.com': { id: 'cus_7', metadata: {} } };
    mockStripe(makeFakeStripe(db));
    try {
      const mk = (status) => ({
        id: 'evt_x', type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1', customer: 'cus_7', status } },
      });
      let res = mockRes();
      await webhook(streamReq(JSON.stringify(mk('trialing')), { 'stripe-signature': 'sig_valid' }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(db['s@example.com'].metadata.fp_sub_active, 'true');
      res = mockRes();
      await webhook(streamReq(JSON.stringify(mk('past_due')), { 'stripe-signature': 'sig_valid' }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(db['s@example.com'].metadata.fp_sub_active, 'false');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('customer.subscription.deleted deactivates sub (idempotent)', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const db = { 's@example.com': { id: 'cus_7', metadata: { fp_sub_active: 'false' } } };
    mockStripe(makeFakeStripe(db));
    try {
      const event = {
        id: 'evt_3', type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_1', customer: 'cus_7', status: 'canceled' } },
      };
      const res = mockRes();
      await webhook(streamReq(JSON.stringify(event), { 'stripe-signature': 'sig_valid' }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(db['s@example.com'].metadata.fp_sub_active, 'false');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('webhook resolves customer by email when no customer id', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const db = { 'buyer@example.com': { id: 'cus_9', metadata: { fp_credits: '0' } } };
    mockStripe(makeFakeStripe(db));
    try {
      const event = {
        id: 'evt_4', type: 'checkout.session.completed',
        data: { object: { id: 'cs_3', mode: 'payment', customer_email: 'buyer@example.com' } },
      };
      const res = mockRes();
      await webhook(streamReq(JSON.stringify(event), { 'stripe-signature': 'sig_valid' }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(db['buyer@example.com'].metadata.fp_credits, '1');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('webhook ignores unknown event types with 200', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    mockStripe(makeFakeStripe({}));
    try {
      const event = { id: 'evt_5', type: 'invoice.paid', data: { object: {} } };
      const res = mockRes();
      await webhook(streamReq(JSON.stringify(event), { 'stripe-signature': 'sig_valid' }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.received, true);
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('webhook GET -> 405', async () => {
    const res = mockRes();
    await webhook({ method: 'GET', headers: {} }, res);
    assert.strictEqual(res.statusCode, 405);
  });

  /* ---------------- /api/scan entitlement gating ---------------- */
  console.log('scan route (entitlement gating, mocked stripe)');
  const LONG_TEXT = 'This is a services agreement between Client and Contractor for design work. '.repeat(10);

  await t('payments live + no email -> 200 gated preview (score + top flag)', async () => {
    const saved = saveEnv();
    scan._resetRateLimits();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    mockStripe(makeFakeStripe({}));
    try {
      const res = mockRes();
      await scan(mockReq({ body: { text: LONG_TEXT } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.gated, true);
      assert.strictEqual(res.body.gateReason, 'no_email');
      assert.strictEqual(res.body.score, DEMO_ANALYSIS.score);
      assert.ok(typeof res.body.summary === 'string' && res.body.summary.length > 20);
      assert.strictEqual(res.body.flags.length, 1);
      assert.strictEqual(res.body.flags[0].risk, 'high'); // top flag = highest severity
      assert.strictEqual(res.body.gatedCount, DEMO_ANALYSIS.flags.length - 1);
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('payments live + invalid email -> 200 gated preview (treated as no email)', async () => {
    const saved = saveEnv();
    scan._resetRateLimits();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    mockStripe(makeFakeStripe({}));
    try {
      const res = mockRes();
      await scan(mockReq({ body: { text: LONG_TEXT, email: 'not-an-email' } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.gated, true);
      assert.strictEqual(res.body.gateReason, 'no_email');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('payments live + new email -> 200 full report, free scan claimed (no credits touched)', async () => {
    const saved = saveEnv();
    scan._resetRateLimits();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const db = {};
    mockStripe(makeFakeStripe(db));
    try {
      const res = mockRes();
      await scan(mockReq({ body: { text: LONG_TEXT, email: 'New@Example.com' } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.gated, undefined);
      assert.strictEqual(res.body.freeScan, true);
      assert.strictEqual(res.body.flags.length, DEMO_ANALYSIS.flags.length);
      // Customer created, normalized email, free scan recorded, no credits granted/spent.
      const rec = db['new@example.com'];
      assert.ok(rec, 'customer should exist under the normalized email');
      assert.strictEqual(rec.metadata.fp_free_used, '1');
      assert.ok(!rec.metadata.fp_credits, 'free claim must not mint credits');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('payments live + same email twice -> second scan is gated (free_used)', async () => {
    const saved = saveEnv();
    scan._resetRateLimits();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const db = {};
    mockStripe(makeFakeStripe(db));
    try {
      let res = mockRes();
      await scan(mockReq({ body: { text: LONG_TEXT, email: 'twice@example.com' } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.freeScan, true);
      res = mockRes();
      await scan(mockReq({ body: { text: LONG_TEXT, email: 'twice@example.com' } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.gated, true);
      assert.strictEqual(res.body.gateReason, 'free_used');
      assert.strictEqual(res.body.gatedCount, DEMO_ANALYSIS.flags.length - 1);
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('free claim normalizes email: uppercase + plus-addressing share one claim', async () => {
    const saved = saveEnv();
    scan._resetRateLimits();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const db = {};
    mockStripe(makeFakeStripe(db));
    try {
      let res = mockRes();
      await scan(mockReq({ body: { text: LONG_TEXT, email: 'PRO+Tag@Example.COM' } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.freeScan, true);
      assert.ok(db['pro+tag@example.com'], 'stored under normalized email, got: ' + Object.keys(db));
      // Same address, different casing/format -> already claimed, not a second free scan.
      res = mockRes();
      await scan(mockReq({ body: { text: LONG_TEXT, email: 'pro+tag@example.com' } }), res);
      assert.strictEqual(res.body.gated, true);
      assert.strictEqual(res.body.gateReason, 'free_used');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('racing free claims for the same email grant only one free scan', async () => {
    const saved = saveEnv();
    scan._resetRateLimits();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const db = {};
    mockStripe(makeFakeStripe(db));
    try {
      const res1 = mockRes();
      const res2 = mockRes();
      await Promise.all([
        scan(mockReq({ body: { text: LONG_TEXT, email: 'race@example.com' } }), res1),
        scan(mockReq({ body: { text: LONG_TEXT, email: 'race@example.com' } }), res2),
      ]);
      const full = [res1, res2].filter((r) => r.body.freeScan === true).length;
      const gated = [res1, res2].filter((r) => r.body.gated === true).length;
      assert.strictEqual(full, 1, 'exactly one full free report');
      assert.strictEqual(gated, 1, 'the loser gets the gated report');
      assert.strictEqual(db['race@example.com'].metadata.fp_free_used, '1');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('free claim when Stripe fails mid-claim -> 502 free_scan_failed (no report served)', async () => {
    const saved = saveEnv();
    scan._resetRateLimits();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const factory = makeFakeStripe({});
    // Break customer creation to simulate a Stripe outage mid-claim.
    const broken = () => {
      const stripe = factory();
      stripe.customers.create = async () => { throw new Error('stripe exploded'); };
      return stripe;
    };
    mockStripe(broken);
    try {
      const res = mockRes();
      await scan(mockReq({ body: { text: LONG_TEXT, email: 'unlucky@example.com' } }), res);
      assert.strictEqual(res.statusCode, 502);
      assert.strictEqual(res.body.error, 'free_scan_failed');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('claimFreeScan helper: sets fp_free_used, idempotent on re-claim', async () => {
    const saved = saveEnv();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const db = { 'old@example.com': { id: 'cus_old', metadata: { fp_credits: '2' } } };
    mockStripe(makeFakeStripe(db));
    try {
      const { claimFreeScan } = require('../lib/entitlements');
      const first = await claimFreeScan('  OLD@example.com ');
      assert.strictEqual(first.alreadyClaimed, false);
      assert.strictEqual(first.customerId, 'cus_old');
      assert.strictEqual(db['old@example.com'].metadata.fp_free_used, '1');
      assert.strictEqual(db['old@example.com'].metadata.fp_credits, '2'); // untouched
      const second = await claimFreeScan('old@example.com');
      assert.strictEqual(second.alreadyClaimed, true);
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('identical contract text reuses the cached analysis (one LLM call for preview + unlock)', async () => {
    const saved = saveEnv();
    scan._resetRateLimits();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    delete process.env.LLM_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-fake';
    const db = {};
    mockStripe(makeFakeStripe(db));
    let fetchCalls = 0;
    const savedFetch = global.fetch;
    global.fetch = async () => {
      fetchCalls++;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                score: 61,
                summary: 'A fairly risky agreement with several clauses worth negotiating before you sign.',
                flags: [{ title: 'Uncapped indemnity', risk: 'high', clause: 'Contractor shall indemnify Client without limitation.', whyItMatters: 'Exposure can exceed the project fee.', whatToDo: 'Cap it at the fees paid.' }],
              }),
            },
          }],
        }),
      };
    };
    try {
      const text = 'cache-probe contract text. ' + 'x'.repeat(200);
      // 1. anonymous gated preview
      let res = mockRes();
      await scan(mockReq({ body: { text } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.gated, true);
      assert.strictEqual(res.body.score, 61);
      // 2. email unlock of the same text — must reuse the cached analysis
      res = mockRes();
      await scan(mockReq({ body: { text, email: 'cache@example.com' } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.freeScan, true);
      assert.strictEqual(res.body.score, 61, 'unlock must show the same score as the preview');
      assert.strictEqual(fetchCalls, 1, 'second pass over identical text must not re-run the LLM');
    } finally { global.fetch = savedFetch; unmockStripe(); restoreEnv(saved); }
  });

  await t('payments live + credits -> 200 and credit decremented', async () => {
    const saved = saveEnv();
    scan._resetRateLimits();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const db = { 'paid@example.com': { id: 'cus_p', metadata: { fp_credits: '2' } } };
    mockStripe(makeFakeStripe(db));
    try {
      const res = mockRes();
      await scan(mockReq({ body: { text: LONG_TEXT, email: 'paid@example.com' } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.demoMode, true);
      assert.strictEqual(db['paid@example.com'].metadata.fp_credits, '1');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('payments live + active sub -> 200 and no decrement', async () => {
    const saved = saveEnv();
    scan._resetRateLimits();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const db = { 'sub@example.com': { id: 'cus_s', metadata: { fp_credits: '5', fp_sub_active: 'true' } } };
    mockStripe(makeFakeStripe(db));
    try {
      const res = mockRes();
      await scan(mockReq({ body: { text: LONG_TEXT, email: 'sub@example.com' } }), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(db['sub@example.com'].metadata.fp_credits, '5');
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  await t('payments live + email via query param works', async () => {
    const saved = saveEnv();
    scan._resetRateLimits();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    const db = { 'q@example.com': { id: 'cus_q', metadata: { fp_credits: '1' } } };
    mockStripe(makeFakeStripe(db));
    try {
      const req = mockReq({ body: { text: LONG_TEXT } });
      req.query = { email: 'q@example.com' };
      const res = mockRes();
      await scan(req, res);
      assert.strictEqual(res.statusCode, 200);
    } finally { unmockStripe(); restoreEnv(saved); }
  });

  /* ---------------- LLM wiring (mocked fetch) ---------------- */
  console.log('LLM wiring (mocked fetch)');
  const realFetch = global.fetch;
  function mockFetchJson(obj) {
    let seen = null;
    global.fetch = async (url, opts) => {
      seen = { url, opts: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] }) };
    };
    return () => seen;
  }
  function restoreFetch() { global.fetch = realFetch; }

  await t('OPENAI_API_KEY triggers live path with defaults', async () => {
    const saved = saveEnv();
    delete process.env.LLM_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-openai-fake';
    const getSeen = mockFetchJson({ score: 10, summary: 'fine', flags: [] });
    try {
      const { analyzeContract } = require('../lib/analysis');
      const out = await analyzeContract('Some contract text here.');
      assert.strictEqual(out.demoMode, false);
      assert.strictEqual(out.score, 10);
      const seen = getSeen();
      assert.ok(seen.url === 'https://api.openai.com/v1/chat/completions', seen.url);
      assert.strictEqual(seen.opts.model, 'gpt-4o-mini');
      const userMsg = seen.opts.messages.find((m) => m.role === 'user').content;
      assert.ok(userMsg.includes('<contract>'), 'missing contract delimiters');
      assert.ok(userMsg.includes('Some contract text here.'));
    } finally { restoreFetch(); restoreEnv(saved); }
  });

  await t('OPENAI_BASE_URL / OPENAI_MODEL overrides are honored', async () => {
    const saved = saveEnv();
    delete process.env.LLM_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-openai-fake';
    process.env.OPENAI_BASE_URL = 'https://proxy.example.com/v1/';
    process.env.OPENAI_MODEL = 'custom-model';
    const getSeen = mockFetchJson({ score: 5, summary: 'ok', flags: [] });
    try {
      const { analyzeContract } = require('../lib/analysis');
      await analyzeContract('x'.repeat(100));
      const seen = getSeen();
      assert.strictEqual(seen.url, 'https://proxy.example.com/v1/chat/completions');
      assert.strictEqual(seen.opts.model, 'custom-model');
    } finally { restoreFetch(); restoreEnv(saved); }
  });

  await t('legacy LLM_API_KEY still works as fallback', async () => {
    const saved = saveEnv();
    delete process.env.OPENAI_API_KEY;
    process.env.LLM_API_KEY = 'sk-legacy-fake';
    const getSeen = mockFetchJson({ score: 5, summary: 'ok', flags: [] });
    try {
      const { analyzeContract } = require('../lib/analysis');
      const out = await analyzeContract('x'.repeat(100));
      assert.strictEqual(out.demoMode, false);
      assert.ok(getSeen().url.includes('api.openai.com'));
    } finally { restoreFetch(); restoreEnv(saved); }
  });

  await t('long input is truncated to LLM_MAX_INPUT_CHARS', async () => {
    const saved = saveEnv();
    delete process.env.LLM_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-openai-fake';
    const getSeen = mockFetchJson({ score: 5, summary: 'ok', flags: [] });
    try {
      const { analyzeContract, LLM_MAX_INPUT_CHARS } = require('../lib/analysis');
      assert.strictEqual(LLM_MAX_INPUT_CHARS, 12000);
      await analyzeContract('z'.repeat(50000));
      const userMsg = getSeen().opts.messages.find((m) => m.role === 'user').content;
      assert.ok(userMsg.length < 50000, 'input was not truncated');
      assert.ok(userMsg.includes('z'.repeat(100)));
    } finally { restoreFetch(); restoreEnv(saved); }
  });

  await t('system prompt tells the model to ignore embedded instructions', async () => {
    const { buildSystemPrompt } = require('../lib/analysis');
    const p = buildSystemPrompt();
    assert.ok(p.toLowerCase().includes('never as instructions') || p.includes('as DATA'));
  });

  console.log(`\n${passed} tests passed${process.exitCode ? ' (WITH FAILURES)' : ''}.`);
})();
