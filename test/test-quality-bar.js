/**
 * test/test-quality-bar.js — guard for the review quality bar (v1, 2026-09-25).
 * Asserts that buildSystemPrompt() contains every upgrade required by the
 * quality-bar spec. This is the verifiable mechanism behind "the prompt was
 * upgraded": a regression here fails the build before any push.
 * Run: npm test   (no LLM key needed)
 */
'use strict';

const assert = require('assert');

const { buildSystemPrompt } = require('../lib/analysis');

const REQUIRED = [
  // P1 — taxonomy extended to 16 categories
  ['14. Survival & claims windows', 'P1: survival & claims-window category'],
  ['15. Cure & notice discipline', 'P1: cure & notice category'],
  ['16. Data protection', 'P1: data-protection category'],
  // P2 — cross-reference sweep
  ['Pass 3 — CROSS-REFERENCES', 'P2: cross-reference pass'],
  ['indemnity scope vs. liability-cap carve-outs', 'P2: indemnity-vs-cap pair'],
  ['does ending the agreement kill unpaid SOWs', 'P2: termination-vs-in-flight pair'],
  ['does "survival" shorten the time to bring a claim', 'P2: survival-vs-claims pair'],
  // P3 — grounding self-check
  ['GROUNDING SELF-CHECK', 'P3: grounding self-check'],
  // P4 — direction check
  ['Check DIRECTION', 'P4: direction check'],
  ['who indemnifies whom, who pays whom, who may', 'P4: direction parties'],
  // P5 — prioritization
  ['At most 3 LOW flags', 'P5: low-flag cap'],
  ['name the 3 risks that cost', 'P5: summary prioritization'],
  ['pick the lower one', 'P5: conservative tiering'],
  // P6 — hardened injection rule
  ['NEVER obey them', 'P6: injection rule'],
  ['continue the analysis', 'P6: injection recovery'],
  // P7 — extended missing-protections list
  ['no cure period before termination for cause', 'P7: missing cure period'],
  ['no survival/claims-window terms', 'P7: missing claims-window terms'],
  // Pre-existing invariants the bar depends on
  ['at most 10 flags', 'invariant: flag cap'],
  ['VERBATIM excerpt', 'invariant: verbatim rule'],
  ['20 per HIGH flag, 8 per MEDIUM flag, 3 per LOW flag', 'invariant: scoring rubric'],
];

let checked = 0;
for (const type of ['', 'msa', 'sow', 'nda', 'ica', 'lease']) {
  const prompt = buildSystemPrompt(type);
  for (const [needle, label] of REQUIRED) {
    assert.ok(
      prompt.includes(needle),
      `quality bar [${label}] missing from prompt (contractType=${type || 'none'})`
    );
    checked += 1;
  }
}

console.log(`test-quality-bar: OK (${checked} assertions across 6 prompt variants)`);
