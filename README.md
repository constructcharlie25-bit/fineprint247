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
- **LLM:** any OpenAI-compatible chat-completions API via `fetch` (no SDK). Key comes from `LLM_API_KEY`.
- **File parsing:** `unpdf` (PDF) + `mammoth` (DOCX), server-side
- **Payments:** Stripe Checkout — **stubbed** (see below)
- **Hosting target:** Vercel free tier (zero-config: static files + `api/`)

## Project structure

```
fineprint/
├── index.html            # Landing page: hero, how-it-works, pricing, FAQ, waitlist, disclaimer
├── scan.html             # Scanner app: textarea + file upload, results view
├── css/style.css         # All styles (mobile-friendly, no framework)
├── js/scan.js            # Scanner UI logic: upload, render score/flags, copy/download, pay buttons
├── api/
│   ├── scan.js           # POST /api/scan — extract text (if file) → analyze → JSON report
│   ├── sample.js         # GET /api/sample — demo contract text for "Try the sample"
│   ├── checkout.js       # POST /api/checkout — Stripe Checkout (STUBBED, TODO markers)
│   ├── webhook.js        # POST /api/webhook — Stripe events (STUBBED, TODO markers)
│   └── waitlist.js       # POST /api/waitlist — email capture (file-based, see note)
├── lib/
│   └── analysis.js       # System prompt, analyzeContract(), extractText(), demo fixtures
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

1. **Input** — user pastes text or uploads PDF/DOCX/TXT (≤4MB). Files are
   base64-encoded client-side and text is extracted server-side in `api/scan.js`.
2. **Analysis** — `lib/analysis.js#analyzeContract()`:
   - If `LLM_API_KEY` is set → calls the chat-completions endpoint with a
     strong system prompt demanding **JSON only**: `{score, summary, flags[]}`,
     then validates/clamps/sorts the result.
   - If not set → **demo mode**: returns a realistic canned analysis of a
     built-in sample contract (score 72/100, 9 flags) so the whole UI flow is
     testable with zero keys and zero spend.
3. **Report** — the frontend renders a score dial, band label (Low/Medium/High
   risk), summary, and flag cards (clause quote → why it matters → what to do),
   with copy-to-clipboard and Markdown download.

## Run locally

```bash
cd fineprint
npm install

# Option A — full local app (recommended):
node test/e2e-server.js        # → http://localhost:3000/scan.html
# Runs in demo mode unless LLM_API_KEY is set (create a .env from .env.example).

# Option B — API tests only:
npm test                       # 16 tests, all offline

# Option C — Vercel dev (closest to production):
npx vercel dev
```

## API reference

| Route | Method | Body | Notes |
|---|---|---|---|
| `/api/scan` | POST | `{text}` or `{fileBase64, filename}` | 200 → report; 400/413/422 on bad input |
| `/api/sample` | GET | — | demo contract text |
| `/api/checkout` | POST | `{mode: "single"\|"subscription"}` | 501 until Stripe is configured |
| `/api/webhook` | POST | Stripe event | stubbed until Step 7 of SETUP.md |
| `/api/waitlist` | POST | `{email}` | file-based; replace with email provider before launch |

## Payments status

Stripe Checkout is **cleanly stubbed, not wired**: `api/checkout.js` returns
`501 payments_not_configured` until `STRIPE_SECRET_KEY` is set, and the real
`stripe.checkout.sessions.create` call is present but commented out behind
`TODO` markers (same for webhook signature verification in `api/webhook.js`).
The frontend pay buttons degrade gracefully to a "free during beta" message.
See `SETUP.md` steps 4, 6, 7.

## Security notes

- **No secrets anywhere in code, comments, or docs** — only env var names
  (`.env.example`). The LLM key is read from `process.env` at request time.
- Uploads are capped (4MB), text is length-capped, and error messages never
  leak stack traces to the client.
- `npm test` includes a check that the system prompt constrains the model to
  JSON-only output and that responses are schema-validated before serving.
