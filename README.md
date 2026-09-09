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
├── js/scan.js            # Scanner UI logic: upload, gated reports, unlock flow, negotiation emails, pay buttons
├── api/
│   ├── scan.js           # POST /api/scan — extract text → analyze → gated preview or full report (free-tier claim inline)
│   ├── sample.js         # GET /api/sample — demo contract text for "Try the sample"
│   ├── checkout.js       # POST /api/checkout — Stripe Checkout sessions ($5 single / $20 5-pack / $29 mo)
│   ├── webhook.js        # POST /api/webhook — Stripe events → credits/subscription on customer metadata
│   └── tiers.js          # GET /api/tiers — which pricing tiers are enabled (pack hidden unless STRIPE_PRICE_PACK set)
├── lib/
│   ├── analysis.js       # System prompt, analyzeContract(), extractText(), demo fixtures
│   ├── stripe.js         # Lazy Stripe client (null when STRIPE_SECRET_KEY unset)
│   ├── entitlements.js   # Credits/subscription via Stripe Customer metadata (no database)
│   └── ratelimit.js      # In-memory per-IP sliding-window limiter (best-effort on serverless)
├── test/
│   ├── test-api.js       # 16 API tests (run: npm test)
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
| `/api/scan` | POST | `{text, email?}` or `{fileBase64, filename, email?}` | 200 → full report, or gated preview `{gated: true, gateReason}` when payments are live; 400/413/422 on bad input; 500/502 on Stripe failures |
| `/api/sample` | GET | — | demo contract text |
| `/api/checkout` | POST | `{mode: "single"\|"pack"\|"subscription", email}` | 200 → `{url}`; 501 until `STRIPE_SECRET_KEY` is set; `pack` needs `STRIPE_PRICE_PACK` |
| `/api/webhook` | POST | Stripe event (raw body) | verifies signature; grants credits (count from session metadata) / toggles subscription |
| `/api/tiers` | GET | — | `{tiers: {single, pack, subscription}}`; `pack` is false unless `STRIPE_PRICE_PACK` is set |

## Payments status

Stripe Checkout is **fully wired**: `api/checkout.js` creates real Checkout
sessions ($5 one-time via `STRIPE_PRICE_SINGLE`, $20 / 5-scan pack via
`STRIPE_PRICE_PACK`, $29/mo via `STRIPE_PRICE_MONTHLY`), `api/webhook.js`
verifies signatures and records entitlements on the Stripe Customer's
metadata (`fp_credits`, `fp_sub_active`, `fp_free_used`), and `api/scan.js`
enforces them (gated preview once the free scan is used). No database — see
`lib/entitlements.js`. Until `STRIPE_SECRET_KEY` is set, checkout returns
`501 payments_not_configured` and scans stay free (demo/beta mode).

## Security notes

- **No secrets anywhere in code, comments, or docs** — only env var names
  (`.env.example`). The LLM key is read from `process.env` at request time.
- Uploads are capped (4MB), text is length-capped, and error messages never
  leak stack traces to the client.
- `npm test` includes a check that the system prompt constrains the model to
  JSON-only output and that responses are schema-validated before serving.
