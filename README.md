# FinePrint (MVP)

**FinePrint** is an AI contract risk scanner for freelancers and small
agencies. Paste contract text (or upload a PDF/DOCX), click **Scan**, and get
a risk report: an overall 0–100 risk score plus each flagged clause with its
risk level, a plain-English explanation, and a practical negotiation
suggestion.

> **Disclaimer:** FinePrint is an informational tool, not a law firm, and
> nothing it produces is legal advice. This disclaimer appears on the landing
> page, the scanner page, and every report.

## Stack

- **Frontend:** plain HTML + CSS + vanilla JS (no framework) — `index.html`, `scan.html`, `css/`, `js/`
- **Backend:** Node.js serverless functions in `api/` (Vercel-style: each file exports a `(req, res)` handler)
- **LLM:** any OpenAI-compatible chat-completions API via `fetch` (no SDK). Key comes from `OPENAI_API_KEY` (`LLM_API_KEY` still works as a legacy alias).
- **File parsing:** `unpdf` (PDF) + `mammoth` (DOCX), server-side
- **Payments:** Stripe Checkout — fully wired (`stripe` npm package)
- **Entitlements:** Stripe Customer metadata, no database (`lib/entitlements.js`)
- **Hosting target:** Vercel free tier (zero-config: static files + `api/`)

## Project structure

```
fineprint/
├── index.html            # Landing page: hero, how-it-works, pricing, FAQ, free-scan capture, disclaimer
├── scan.html             # Scanner app: textarea + file upload, results view
├── css/style.css         # All styles (mobile-friendly, no framework)
├── js/scan.js            # Scanner UI logic: upload, free risk-score teaser, paid unlock, negotiation emails, pay buttons
├── api/
│   ├── scan.js           # POST /api/scan — extract text → analyze → free teaser (one per email) or full report for paid users
│   ├── unlock.js         # POST /api/unlock — redeem a paid unlock token for the full report instantly (no re-scan)
│   ├── chat.js           # POST /api/chat — follow-up Q&A about a report ("Ask about your contract"): free tier gets 2 questions, paid tiers unlimited
│   ├── sample.js         # GET /api/sample — demo contract text for "Try the sample"
│   ├── checkout.js       # POST /api/checkout — Stripe Checkout sessions ($5 single / $20 5-pack / $29 mo)
│   ├── webhook.js        # POST /api/webhook — Stripe events → credits/subscription on customer metadata
│   └── tiers.js          # GET /api/tiers — which pricing tiers are enabled (pack hidden unless STRIPE_PRICE_PACK set)
├── lib/
│   ├── analysis.js       # System prompt, analyzeContract(), extractText(), demo fixtures, toClientReport() flag normalization, chatCompletion() LLM transport
│   ├── token.js          # Paid unlock tokens: HKDF-derived AES-256-GCM + HMAC, 24h expiry, ~100KB cap (no new env var)
│   ├── stripe.js         # Lazy Stripe client (null when STRIPE_SECRET_KEY unset)
│   ├── entitlements.js   # Credits/subscription/chat usage via Stripe Customer metadata (no database)
│   └── ratelimit.js      # In-memory per-IP sliding-window limiter (best-effort on serverless)
├── test/
│   ├── test-api.js       # 102 API tests (run: npm test)
│   ├── e2e-server.js     # Dev-only static+API server (run: node test/e2e-server.js)
│   ├── make-fixtures.py  # Generates test/contract.docx
│   ├── contract.pdf      # Real-world sample PDF fixture (W3C dummy file)
│   └── contract.docx     # Generated minimal DOCX fixture
├── .env.example          # Env var NAMES only — no secrets
├── package.json          # 2 runtime deps: unpdf, mammoth
├── SETUP.md              # Non-technical launch checklist (domain, Vercel, Stripe, keys)
└── README.md             # This file
```

## How it works

1. **Input** — user pastes text or uploads PDF/DOCX/TXT (≤4MB), plus their
   email (used for entitlement checks once payments are live). Files are
   base64-encoded client-side and text is extracted server-side in `api/scan.js`.
2. **Analysis** — `lib/analysis.js#analyzeContract()`:
   - If `OPENAI_API_KEY` (or legacy `LLM_API_KEY`) is set → calls the
     chat-completions endpoint with a strong system prompt demanding
     **JSON only**: `{score, summary, flags[]}`, then validates/clamps/sorts
     the result. Contract text is wrapped in `<contract>` delimiters and the
     model is instructed to treat it as data, not instructions; input sent to
     the model is capped at 12,000 chars.
   - If not set → **demo mode**: returns a realistic canned analysis of a
     built-in sample contract (score 72/100, 9 flags) so the whole UI flow is
     testable with zero keys and zero spend.
3. **Report** — the frontend renders a score dial, band label (Low/Medium/High
   risk), summary, and flag cards (clause quote → why it matters → what to
   do → copy-paste pushback email for high-severity flags → lawyer nudge),
   with copy-to-clipboard and Markdown download.

## Free tier (no database)

Everyone sees the risk score + top flag free. Entering an email unlocks the
full report — the first scan per email is free (`fp_free_used="1"` recorded
on the Stripe Customer, no card required). After that it's credits or a
subscription. See `lib/entitlements.js#claimFreeScan` and the gate in
`api/scan.js`. Concurrent claims for one email are serialized per instance.
Identical contract text reuses a 30-minute in-process analysis cache, so the
anonymous preview + email unlock costs one LLM call and shows one consistent
score.

## Run locally

```bash
cd fineprint
npm install

# Option A — full local app (recommended):
node test/e2e-server.js        # → http://localhost:3000/scan.html
# Runs in demo mode unless OPENAI_API_KEY is set (create a .env from .env.example).

# Option B — API tests only:
npm test                       # 62 tests, all offline

# Option C — Vercel dev (closest to production):
npx vercel dev
```

## API reference

| Route | Method | Body | Notes |
|---|---|---|---|
| `/api/scan` | POST | `{text, email}` or `{fileBase64, filename, email}` | payments live: 200 → free **teaser** (score, severity counts, first finding, unlock token) for a new email, or the full report for subscribers/credit holders; 400 `email_required_for_free_scan` without an email; 403 `teaser_already_claimed` on repeat emails; 400/413/422 on bad input; 500/502 on Stripe failures |
| `/api/unlock` | POST | `{email, token}` | 200 → full report instantly (no LLM call) when the token is valid, unexpired, email-bound, and the caller has paid (subscriber or ≥1 credit, spent here); 400/403 `unlock_invalid`, 410 `unlock_expired`, 402 `payment_required` |
| `/api/chat` | POST | `{email, token, message, history?}` | Follow-up Q&A about the report. Server re-derives context from the token (client report content is never trusted). Free tier: exactly 2 questions (teaser context only — locked findings stay hidden), then 402 `free_questions_exhausted` with the $5 upsell; paid/subscriber: unlimited (full report context). History validated, last 10 turns sent. Rate limits: 20/hr free, 50/hr paid per email. |
| `/api/sample` | GET | — | demo contract text |
| `/api/checkout` | POST | `{mode: "single"\|"pack"\|"subscription", email}` | 200 → `{url}`; 501 until `STRIPE_SECRET_KEY` is set; `pack` needs `STRIPE_PRICE_PACK` |
| `/api/webhook` | POST | Stripe event (raw body) | verifies signature; grants credits (count from session metadata) / toggles subscription |
| `/api/tiers` | GET | — | `{tiers: {single, pack, subscription}}`; `pack` is false unless `STRIPE_PRICE_PACK` is set |

## Payments status

Stripe Checkout is **fully wired**: `api/checkout.js` creates real Checkout
sessions ($5 one-time via `STRIPE_PRICE_SINGLE`, $20 / 5-scan pack via
`STRIPE_PRICE_PACK`, $29/mo via `STRIPE_PRICE_MONTHLY`), `api/webhook.js`
verifies signatures and records entitlements on the Stripe Customer's
metadata (`fp_credits`, `fp_sub_active`, `fp_free_used`, plus `fp_ever_paid`
on any completed one-time payment and `fp_chat_used` counting free Q&A
questions for `api/chat.js`), and `api/scan.js`
enforces them. No database — see `lib/entitlements.js`. Until
`STRIPE_SECRET_KEY` is set, checkout returns
`501 payments_not_configured` and scans stay free (demo/beta mode).

## Free teaser + paid unlock

The free tier is a **teaser**, not a free report: `POST /api/scan` with a new
email returns the 0–100 risk score, severity counts (e.g. "3 high, 2 medium"),
and the first finding in full — the pushback email templates stay locked. One
teaser per email (`fp_free_used` on the Stripe Customer; lowercase + trim
normalized, plus-addressing preserved). The response also carries an encrypted
**unlock token** and a "Unlock the full report — $5" CTA.

The unlock token (`lib/token.js`) is self-contained: the complete report is
AES-256-GCM encrypted, HMAC-bound (version + expiry + IV + ciphertext), tied
to the claimant's email, and expires after 24 hours. After the $5 checkout
succeeds, the client keeps the token in `sessionStorage` (never in a URL) and
POSTs it to `/api/unlock`, which verifies entitlement and returns the full
report — score, every finding, and every negotiation email template — with **no
new LLM call**. Missing/expired/invalid tokens (or reports too large to
tokenize, ~100KB cap) fall back to a fresh paid analysis, so paid users always
get their report.

**Key choice — no new env var:** the token keys are derived via HKDF-SHA256
from the existing `STRIPE_WEBHOOK_SECRET` (distinct info strings for the AES
and HMAC keys, so they are cryptographically isolated from the webhook signing
key). Consequences, documented here rather than hidden:

1. If `STRIPE_WEBHOOK_SECRET` is ever rotated, all outstanding unlock tokens
   invalidate immediately (HMAC verification fails). Paid users still get
   their report via the paid re-scan fallback.
2. If `STRIPE_WEBHOOK_SECRET` is unset, tokens cannot be sealed — the teaser
   claim fails closed with 502 instead of granting a teaser that could never
   be unlocked.

## Follow-up Q&A chat ("Ask about your contract")

After a report renders, a chat panel offers follow-up questions about that
report. `POST /api/chat` takes the unlock token (never report content — the
server decrypts the token and re-derives the context itself), the question,
and optional conversation history (validated, last 10 turns sent to the LLM).

Gating is deliberate:

- **Free tier — exactly 2 questions**, tracked server-side in the Stripe
  Customer metadata flag `fp_chat_used` (never a client counter). The free
  chat context is the *teaser view only* (score, severity counts, first
  finding): revealing locked findings in chat would make the $5 unlock
  pointless, and the 2 questions are a hook, not a back door. Exhaustion
  returns 402: "You've used your 2 free questions — unlock the full report
  for $5 for unlimited Q&A."
- **Paid tiers — unlimited Q&A** (50/hr rate limit) with the full report as
  context: credit holders, subscribers, and anyone with `fp_ever_paid`
  (a buyer who spent their last credit is still a paying customer).
- Demo/beta mode (no `STRIPE_SECRET_KEY`): no payments exist, so Q&A is open
  with full context.

The counter increments only after a successful answer, inside a per-email
lock — a failed LLM call never burns a free question, and parallel requests
can't double-spend the budget.

## Security notes

- **No secrets anywhere in code, comments, or docs** — only env var names
  (`.env.example`). The LLM key is read from `process.env` at request time.
- Uploads are capped (4MB), text is length-capped, and error messages never
  leak stack traces to the client.
- `npm test` includes a check that the system prompt constrains the model to
  JSON-only output and that responses are schema-validated before serving.
