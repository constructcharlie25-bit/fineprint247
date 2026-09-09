# FinePrint — Launch Checklist

Follow these steps in order. You don't need to be technical — each step says
exactly where to click. Budget: ~$11 for the domain (done) + ~$5–10 prepaid
LLM credit to start. Vercel and Stripe accounts are free.

> ⚠️ Start with Stripe in **test mode**. Only switch to live keys when you're
> ready to take real money (Step 8).

**Already done:** domain `fineprint247.com` bought (Cloudflare, $11) and
pointed at Vercel. The site is live at https://fineprint247.com. The payment
code is fully wired — no code changes needed, only the accounts/keys below.

---

## 1. Create a Stripe account (free)

1. Go to [stripe.com](https://stripe.com) → **Start now**, complete signup.
2. Toggle **Test mode** ON (top-right of the dashboard) while setting up.

### 1a. Get your API keys (test mode first)

1. Dashboard → **Developers → API keys**.
2. Copy the **Secret key** (`sk_test_…`). You'll paste it into Vercel later.
   Never share the secret key.

### 1b. Create the two products

1. Dashboard → **Product catalogue → Create product**.
2. Product 1:
   - Name: `Single scan`
   - Price: `$5`, **One-time**
   - Copy the **Price ID** (`price_…`) — you'll need it.
3. Product 2:
   - Name: `Unlimited scans`
   - Price: `$29`, **Recurring → Monthly**
   - Copy the **Price ID** (`price_…`).
4. *(Optional — enables the $20 / 5-scan pack on the pricing page.)* Product 3:
   - Name: `5-scan pack`
   - Price: `$20`, **One-time**
   - Copy the **Price ID**, then add it to Vercel as `STRIPE_PRICE_PACK`
     (the site hides the pack tier automatically until this is set).

### 1c. Set up the webhook

This is how FinePrint learns a payment succeeded (no database — scan credits
are stored on the Stripe Customer's metadata).

1. Dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://fineprint247.com/api/webhook`
3. Select these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Click **Add endpoint**, then **Reveal** the **Signing secret** (`whsec_…`) and copy it.

## 2. Get an LLM API key (~$5–10 prepaid)

The scanner calls an AI model to analyze contracts. Without a key the app
stays in demo mode (canned sample report).

1. Go to [platform.openai.com](https://platform.openai.com) → sign up.
2. **Billing → Add funds**: add **$5–10** prepaid credit (pay-as-you-go; each scan costs a fraction of a cent).
3. **API keys → Create new secret key**. Copy it — it starts with `sk-` and is shown only once.
4. (Optional) You can use any OpenAI-compatible provider instead — see `.env.example` for `OPENAI_BASE_URL` / `OPENAI_MODEL`.

## 3. Add environment variables in Vercel

1. Vercel → your **fineprint247** project → **Settings → Environment Variables**.
2. Add each of these (select **Production**, **Preview**, and **Development**), then **Save**:

   | Variable | Value | Where you got it |
   |---|---|---|
   | `STRIPE_SECRET_KEY` | `sk_test_…` (test for now) | Step 1a |
   | `STRIPE_PRICE_SINGLE` | `price_…` ($5 one-time) | Step 1b |
   | `STRIPE_PRICE_MONTHLY` | `price_…` ($29/mo) | Step 1b |
   | `STRIPE_PRICE_PACK` | `price_…` ($20 one-time, 5 scans — optional, step 1b.4) | Step 1b |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_…` | Step 1c |
   | `OPENAI_API_KEY` | `sk-…` | Step 2 |
   | `OPENAI_BASE_URL` | _(optional)_ e.g. `https://api.openai.com/v1` | Step 2.4 |
   | `OPENAI_MODEL` | _(optional)_ defaults to `gpt-4o-mini` | Step 2.4 |
   | `APP_URL` | `https://fineprint247.com` | fixed |

3. After saving, **redeploy**: Vercel → **Deployments → ⋯ → Redeploy** (env vars only take effect on a fresh deployment).

## 4. Test in Stripe test mode

1. Open https://fineprint247.com/#pricing, enter your email, click **Buy a scan**.
2. Pay with test card `4242 4242 4242 4242` (any future expiry, any CVC).
3. You should land back on `/scan.html?paid=1` with a "Payment confirmed" notice.
4. Run a scan with that email — it should work and consume one credit.
5. Stripe → **Developers → Webhooks** → your endpoint should show `200` responses.
6. Scan a real contract — confirm the report says **AI report**, not "Demo report".

## 5. Go live checklist

- [ ] The full test-mode purchase above works end-to-end.
- [ ] In Stripe, toggle **test mode OFF**. Replace the four test values in Vercel env vars with the **live** values (`sk_live_…`, live price IDs, live webhook secret). Redeploy.
- [ ] Make a real $5 purchase yourself and confirm the credit lands, then refund it in the Stripe dashboard.
- [ ] Email list: the free teaser captures the user's email on their Stripe Customer record (`fp_free_used`) — that IS the list. To send the onboarding sequence (drafts in the launch-kit), connect a real provider — easiest: [Buttondown](https://buttondown.com) or [ConvertKit](https://convertkit.com) (both free to start) — and wire the welcome email to fire on the free-teaser claim in `api/scan.js`.
- [ ] Read the disclaimer on the site once more — it says FinePrint is not a law firm and not legal advice. Keep it.

## 6. Ongoing costs (rough)

| Item | Cost |
|---|---|
| Domain | $10.46/year (Cloudflare) |
| Vercel hosting | $0 (free tier) |
| Stripe | $0 + ~2.9% + 30¢ per sale (only when you sell) |
| LLM usage | fractions of a cent per scan (~$5–10 credit lasts months at MVP volume) |

## How payments work (for the curious)

- The **Buy** buttons call `POST /api/checkout`, which creates a Stripe
  Checkout session and redirects the buyer to Stripe's hosted payment page.
- After payment, Stripe fires `checkout.session.completed` to
  `/api/webhook`, which writes scan credits (`fp_credits`) or the
  subscription flag (`fp_sub_active`) onto the Stripe Customer's metadata.
- The free tier is a **teaser**: `POST /api/scan` with a new email returns
  the 0–100 risk score, severity counts, and the first finding in full —
  one teaser per email (`fp_free_used`). The response also carries an
  encrypted unlock token; after the $5 checkout succeeds, the client POSTs
  it to `/api/unlock` and gets the complete report instantly, with no new
  LLM call. Paid users without a valid token still get the full report via
  a fresh paid analysis.
- `/api/scan` reads that metadata on every scan: active subscribers scan
  free; everyone else spends one credit per scan (402 when they're out).
- The unlock-token keys are derived from `STRIPE_WEBHOOK_SECRET` (HKDF —
  no extra env var). **Do not rotate the webhook secret casually**: rotation
  invalidates all outstanding unlock tokens (paid users still get their
  report via a fresh paid scan).
- No database to run, back up, or pay for. If you outgrow this, the
  entitlement logic is isolated in `lib/entitlements.js` — swap the Stripe
  metadata calls for database calls there.

## Troubleshooting

- **Checkout returns "not set up yet"** → `STRIPE_SECRET_KEY` isn't set in
  Vercel (or you forgot to redeploy after adding it).
- **Payment succeeds but scans say "out of scans"** → the webhook isn't
  reaching the app: check Stripe → Developers → Webhooks for non-200
  responses, and confirm `STRIPE_WEBHOOK_SECRET` matches the endpoint's
  signing secret.
- **Reports still say "Demo report"** → `OPENAI_API_KEY` isn't set (or no
  redeploy after adding it).
- **Local webhook testing** → the webhook needs the raw request body, so the
  local dev server can't verify signatures. Use the Stripe CLI:
  `stripe listen --forward-to localhost:3000/api/webhook`.
