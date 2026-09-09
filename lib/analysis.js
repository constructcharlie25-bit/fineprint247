/**
 * lib/analysis.js — core contract-analysis logic shared by the API routes.
 *
 * - buildSystemPrompt(): the strong system prompt sent to the LLM.
 * - analyzeContract(text): live LLM analysis, or the canned demo analysis
 *   when no LLM_API_KEY is set (demo mode).
 * - extractText(buffer, filename): pull raw text out of PDF / DOCX / TXT.
 * - SAMPLE_CONTRACT / DEMO_ANALYSIS: the demo-mode fixtures.
 *
 * No secrets live here. The LLM key is read from process.env at call time.
 */

'use strict';

/* ------------------------------------------------------------------ */
/* System prompt                                                       */
/* ------------------------------------------------------------------ */

function buildSystemPrompt() {
  return [
    'You are FinePrint, an expert contract analyst working for the FREELANCER',
    '(the "Contractor") — not the client. A freelancer or small-agency owner',
    'has pasted a client agreement and wants to know what is risky BEFORE signing.',
    '',
    'Analyze the contract text and return ONLY valid JSON. No markdown fences,',
    'no commentary, no preamble. The JSON must match this schema exactly:',
    '',
    '{',
    '  "score": <integer 0-100: overall risk to the freelancer>,',
    '  "summary": "<2-3 sentence plain-English overview of the biggest risks>",',
    '  "flags": [',
    '    {',
    '      "title": "<short label, e.g. \'Unlimited liability\'>",',
    '      "clause": "<verbatim or near-verbatim excerpt of the risky clause, max ~60 words>",',
    '      "risk": "<one of: high | medium | low>",',
    '      "explanation": "<1-2 sentences, plain English, WHY this is risky for a freelancer>",',
    '      "suggestion": "<1-2 sentences, practical: what to ask the client to change>"',
    '    }',
    '  ]',
    '}',
    '',
    'SCORING RUBRIC (risk to the freelancer):',
    '- 0-25 LOW: standard, balanced terms. Normal freelancer agreement.',
    '- 26-50 MODERATE: a few one-sided terms worth negotiating, but signable.',
    '- 51-75 HIGH: several terms that shift serious financial or legal risk onto the freelancer.',
    '- 76-100 CRITICAL: terms that could threaten the freelancer\'s livelihood (uncapped liability,',
    '  broad non-competes, IP grabs, no pay protections).',
    '',
    'WHAT TO LOOK FOR (freelancer perspective):',
    '1. Payment terms: Net 60/90, no late-payment interest, vague invoicing or approval terms.',
    '2. IP ownership: assignment of pre-existing IP, overly broad "work made for hire", no license-back.',
    '3. Liability & indemnification: uncapped liability, one-sided indemnity, indemnifying client negligence.',
    '4. Non-compete / non-solicit: long duration, wide geography, vague "competitive" definitions.',
    '5. Termination: client can terminate for convenience with short notice, no kill fee, no pay for work in progress.',
    '6. Scope creep: unlimited revisions, vague deliverables, no change-order process.',
    '7. Confidentiality: excessively long survival periods, one-sided obligations.',
    '8. Warranties: long warranty periods, fitness-for-purpose guarantees a freelancer cannot meet.',
    '9. Insurance: high coverage minimums disproportionate to the project value.',
    '10. Governing law & venue: far-away jurisdiction favoring the client.',
    '11. Late-delivery penalties that do not apply equally to late payment.',
    '',
    'RULES:',
    '- Return at most 10 flags, ordered by risk (high first). Skip trivial or standard clauses.',
    '- "clause" must be a real excerpt from the provided text, not invented.',
    '- Write for a non-lawyer: plain English, no legalese. Never say "pursuant" or "heretofore".',
    '- Frame suggestions as negotiation points ("Ask the client to..."), NOT as legal advice.',
    '- If the input is clearly not a contract (gibberish, a recipe, a few random words),',
    '  return {"score": 0, "summary": "<explain you need an actual contract text>", "flags": []}.',
    '- If the text is a contract but very short or fragmentary, score conservatively and say so in the summary.',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Demo fixtures                                                       */
/* ------------------------------------------------------------------ */

const SAMPLE_CONTRACT = `INDEPENDENT CONTRACTOR AGREEMENT

This Independent Contractor Agreement ("Agreement") is entered into as of
September 1, 2026, by and between Brightline Studio LLC ("Client") and the
undersigned contractor ("Contractor").

1. SERVICES. Contractor shall provide brand identity and website design
services as described in Exhibit A (the "Work").

2. WORK PRODUCT AND INTELLECTUAL PROPERTY. All Work Product, including any
pre-existing intellectual property, materials, templates, or code incorporated
therein, shall be deemed "work made for hire" and Contractor hereby assigns
all right, title, and interest therein to Client, throughout the world, in
perpetuity.

3. REVISIONS. Contractor shall provide revisions until Client is fully
satisfied, at no additional charge.

4. COMPENSATION AND PAYMENT. Client shall pay Contractor a fixed fee of
$8,500. Client shall pay all undisputed invoices within ninety (90) days of
receipt. No interest shall accrue on late payments by Client.

5. LATE DELIVERY. Contractor shall pay liquidated damages of $250 per day
for each day any milestone is delivered late.

6. TERMINATION. Client may terminate this Agreement for convenience upon
five (5) days' written notice. Upon termination, Contractor shall be entitled
only to fees for milestones completed and accepted prior to termination.

7. INDEMNIFICATION. Contractor shall indemnify, defend, and hold harmless
Client, its officers, and affiliates from any and all claims, damages, and
expenses, including those arising from Client's own negligence, without
limitation as to amount.

8. NON-COMPETE. For twenty-four (24) months following termination, Contractor
shall not provide design services to any business competitive with Client
within a one-hundred (100) mile radius of Client's principal office.

9. CONFIDENTIALITY. Contractor's confidentiality obligations shall survive
for five (5) years following termination of this Agreement.

10. INSURANCE. Contractor shall maintain professional liability insurance
with limits of not less than $2,000,000 per occurrence for the duration of
the engagement.

11. GOVERNING LAW. This Agreement shall be governed by the laws of the State
of Delaware. Venue shall lie exclusively in New Castle County, Delaware.

IN WITNESS WHEREOF, the parties have executed this Agreement as of the date
first written above.`;

const DEMO_ANALYSIS = {
  score: 72,
  summary:
    'This agreement shifts most of the financial and legal risk onto you. You get paid slowly, can be dropped on five days\u2019 notice with no payment for work in progress, hand over more IP than the project itself, and face uncapped liability \u2014 while a two-year non-compete could block future work in your own city. With targeted changes to payment terms, liability, and the IP clause, it becomes signable.',
  flags: [
    {
      title: 'You give away pre-existing IP',
      clause:
        'All Work Product, including any pre-existing intellectual property, materials, templates, or code incorporated therein, shall be deemed "work made for hire" and Contractor hereby assigns all right, title, and interest therein to Client, throughout the world, in perpetuity.',
      risk: 'high',
      explanation:
        'This does not just cover what you make for this client \u2014 it hands over tools, templates, and code you built before this project and may reuse elsewhere.',
      suggestion:
        'Narrow the assignment to work created specifically for this engagement, and expressly exclude your pre-existing materials and reusable libraries.',
    },
    {
      title: 'Unlimited indemnification \u2014 even for the client\u2019s negligence',
      clause:
        "Contractor shall indemnify, defend, and hold harmless Client, its officers, and affiliates from any and all claims, damages, and expenses, including those arising from Client's own negligence, without limitation as to amount.",
      risk: 'high',
      explanation:
        'If anything goes wrong \u2014 even something the client caused \u2014 you foot the entire bill with no cap. A single claim could exceed everything you earn on the project.',
      suggestion:
        'Ask for a mutual indemnity limited to third-party IP claims, and cap your total liability at the fees paid under this agreement.',
    },
    {
      title: 'Paid in 90 days, with no late interest',
      clause:
        'Client shall pay all undisputed invoices within ninety (90) days of receipt. No interest shall accrue on late payments by Client.',
      risk: 'high',
      explanation:
        'Net-90 means you are financing the client\u2019s cash flow for three months \u2014 a serious strain for a freelancer \u2014 and there is no penalty if they pay even later.',
      suggestion:
        'Push for Net 15 or Net 30, and add 1.5% monthly interest on overdue invoices.',
    },
    {
      title: 'Two-year, 100-mile non-compete',
      clause:
        'For twenty-four (24) months following termination, Contractor shall not provide design services to any business competitive with Client within a one-hundred (100) mile radius of Client\u2019s principal office.',
      risk: 'high',
      explanation:
        'This could block you from taking normal client work in your own city for two years after the project ends.',
      suggestion:
        'Ask to remove it entirely, or narrow it to the client\u2019s named direct competitors for a maximum of six months.',
    },
    {
      title: 'No kill fee on termination',
      clause:
        'Client may terminate this Agreement for convenience upon five (5) days\u2019 written notice. Upon termination, Contractor shall be entitled only to fees for milestones completed and accepted prior to termination.',
      risk: 'high',
      explanation:
        'The client can cancel on five days\u2019 notice and you get nothing for half-finished work or the hole it leaves in your schedule.',
      suggestion:
        'Add a 50% kill fee for work in progress and require 30 days\u2019 written notice.',
    },
    {
      title: 'Unlimited revisions',
      clause:
        'Contractor shall provide revisions until Client is fully satisfied, at no additional charge.',
      risk: 'medium',
      explanation:
        '\u201CUntil satisfied\u201D has no end \u2014 this is how fixed-price projects quietly become infinite.',
      suggestion:
        'Include two rounds of revisions in the price and bill additional rounds at your hourly rate.',
    },
    {
      title: 'One-sided late penalties',
      clause:
        'Contractor shall pay liquidated damages of $250 per day for each day any milestone is delivered late.',
      risk: 'medium',
      explanation:
        'You are fined $250 a day for being late, while the client faces zero cost for paying you 90+ days late.',
      suggestion:
        'Make it mutual: remove the daily penalty, or pair it with matching late-payment interest.',
    },
    {
      title: '$2M insurance requirement',
      clause:
        'Contractor shall maintain professional liability insurance with limits of not less than $2,000,000 per occurrence for the duration of the engagement.',
      risk: 'medium',
      explanation:
        'A $2M professional-liability policy can cost $1,000+ per year \u2014 possibly more than this $8,500 project pays you.',
      suggestion:
        'Ask to lower it to $1M, or waive it for projects under a set fee threshold.',
    },
    {
      title: 'Delaware governing law and venue',
      clause:
        'This Agreement shall be governed by the laws of the State of Delaware. Venue shall lie exclusively in New Castle County, Delaware.',
      risk: 'low',
      explanation:
        'If there is ever a dispute, you would be dealing with courts far from home, which favors the client.',
      suggestion:
        'Ask for your home state\u2019s law and venue, or at least non-exclusive venue.',
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Live analysis                                                       */
/* ------------------------------------------------------------------ */

function validateAnalysis(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('bad_response');
  const score = Math.max(0, Math.min(100, Math.round(Number(obj.score) || 0)));
  const summary = String(obj.summary || '').slice(0, 2000);
  const flags = Array.isArray(obj.flags) ? obj.flags.slice(0, 10) : [];
  const clean = flags
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      title: String(f.title || 'Flagged clause').slice(0, 120),
      clause: String(f.clause || '').slice(0, 600),
      risk: ['high', 'medium', 'low'].includes(f.risk) ? f.risk : 'medium',
      explanation: String(f.explanation || '').slice(0, 800),
      suggestion: String(f.suggestion || '').slice(0, 800),
    }))
    .filter((f) => f.clause && f.explanation);
  const order = { high: 0, medium: 1, low: 2 };
  clean.sort((a, b) => order[a.risk] - order[b.risk]);
  return { score, summary, flags: clean };
}

function extractJson(text) {
  // Strip possible markdown fences, then grab the first {...} block.
  const cleaned = String(text).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('bad_response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function analyzeContract(text) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    // Demo mode: realistic canned analysis so the UI is testable without a key.
    return { demoMode: true, ...DEMO_ANALYSIS };
  }

  const baseUrl = (process.env.LLM_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 2500,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: `Analyze this contract for risks to the freelancer:\n\n${text}` },
      ],
    }),
  });

  if (!resp.ok) {
    const err = new Error('llm_error');
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('bad_response');
  return { demoMode: false, ...validateAnalysis(extractJson(content)) };
}

/* ------------------------------------------------------------------ */
/* File text extraction                                                */
/* ------------------------------------------------------------------ */

async function extractText(buffer, filename) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.pdf')) {
    // Lazy require keeps the text path free of the PDF parser's load cost.
    // NOTE: pass a Uint8Array, not a Node Buffer.
    const { extractText: pdfText } = require('unpdf');
    const result = await pdfText(new Uint8Array(buffer));
    const pages = Array.isArray(result.text) ? result.text : [result.text];
    return pages.join('\n');
  }
  if (name.endsWith('.docx')) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  if (name.endsWith('.txt')) {
    return buffer.toString('utf8');
  }
  const err = new Error('unsupported_file');
  err.code = 'unsupported_file';
  throw err;
}

module.exports = {
  buildSystemPrompt,
  analyzeContract,
  extractText,
  validateAnalysis,
  SAMPLE_CONTRACT,
  DEMO_ANALYSIS,
};
