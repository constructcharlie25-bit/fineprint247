/**
 * test/test-frontend-smoke.js — execute js/scan.js against a stub DOM and
 * assert it loads without throwing, on both the scan page (form present)
 * and other pages (form absent, page guard engaged).
 *
 * Why this exists: the 4c2c711 refactor deleted the updateCount() definition
 * while keeping its call sites. The string-matching tests in test-api.js all
 * passed, but every /scan.html load threw a ReferenceError that left the
 * scan button dead. Only executing the script catches that class of bug.
 *
 * Run: npm test
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fakeElement() {
  return {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    scrollIntoView() {},
    focus() {},
    click() {},
    appendChild() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
  };
}

// Every element id referenced by js/scan.js via getElementById.
const KNOWN_IDS = [
  'contractText', 'emailInput', 'contractType', 'charCount', 'scanBtn',
  'sampleBtn', 'clearBtn', 'fileInput', 'spinner', 'results', 'scoreDial',
  'bandLabel', 'summaryText', 'flagsList', 'sevFilter', 'unlockPanel',
  'resultActions', 'moreScansPanel', 'sharePanel', 'sharePanelBody',
  'historyList', 'historyPanel', 'errorBox', 'paidNotice', 'modeBadge',
  'modeNote', 'chatPanel', 'chatLog', 'chatQuota', 'chatForm', 'chatInput',
  'chatSend', 'chatUpsell', 'planBanner', 'planTitle', 'planSub', 'planFine',
  'planCta', 'planEmail', 'stickyCta', 'stickyClose', 'freeScanForm',
  'freeScanEmail', 'freeScanMsg', 'heroScanForm', 'heroContract', 'heroScanMsg',
  'copyBtn', 'downloadBtn', 'printBtn', 'scanAnotherBtn',
];

function makeSandbox({ withForm, handoffText }) {
  const ids = {};
  const sessionStore = handoffText ? { fp_contract: handoffText } : {};
  const sessionStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(sessionStore, k) ? sessionStore[k] : null; },
    setItem(k, v) { sessionStore[k] = String(v); },
    removeItem(k) { delete sessionStore[k]; },
  };
  const location = {
    href: 'https://www.fineprint247.com/scan.html',
    pathname: '/scan.html',
    search: '',
  };
  const document = {
    getElementById(id) {
      if (!withForm) return null;
      if (!ids[id]) ids[id] = fakeElement();
      return ids[id];
    },
    querySelectorAll() { return []; },
    createElement() { return fakeElement(); },
    addEventListener() {},
    body: fakeElement(),
  };
  const window = {
    location,
    sessionStorage,
    history: { replaceState() {} },
    scrollTo() {},
    print() {},
    addEventListener() {},
  };
  return {
    document, window, location, navigator: {},
    sessionStorage, // bare global access, if any
    URLSearchParams,
    JSON, Object, Array, String, Number, Boolean, RegExp, Date, Math, Error,
    setTimeout() { return 0; },
    clearTimeout() {},
    requestAnimationFrame() { return 0; },
    fetch() { return Promise.reject(new Error('no network in smoke test')); },
    console,
  };
}

function loadScanJs(sandbox) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'scan.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'scan.js' });
  return sandbox;
}

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok -', name);
  } catch (e) {
    console.error('  FAIL -', name);
    console.error('        ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n        ') : e));
    process.exitCode = 1;
  }
}

t('smoke: scan.js loads without throwing when the contract form is present', () => {
  // Would have caught the updateCount ReferenceError from 4c2c711.
  loadScanJs(makeSandbox({ withForm: true }));
});

t('smoke: scan.js loads without throwing when the contract form is absent (homepage)', () => {
  loadScanJs(makeSandbox({ withForm: false }));
});

t('smoke: homepage contract handoff prefills the textarea', () => {
  const sb = loadScanJs(makeSandbox({ withForm: true, handoffText: 'PASTED-CONTRACT-TEXT' }));
  const textEl = sb.document.getElementById('contractText');
  assert.strictEqual(textEl.value, 'PASTED-CONTRACT-TEXT', 'handoff text must land in #contractText');
  assert.ok(
    sb.document.getElementById('charCount').textContent.includes('20'),
    'char count must update (got: ' + sb.document.getElementById('charCount').textContent + ')'
  );
});

t('smoke: scan.js only touches known element ids', () => {
  // Guards against typos in getElementById that silently return null.
  const sb = makeSandbox({ withForm: true });
  const seen = new Set();
  const orig = sb.document.getElementById;
  sb.document.getElementById = (id) => { seen.add(id); return orig(id); };
  loadScanJs(sb);
  for (const id of seen) {
    assert.ok(KNOWN_IDS.includes(id), 'scan.js references unknown element id: ' + id);
  }
});

console.log(`\n${passed} smoke tests passed.`);
