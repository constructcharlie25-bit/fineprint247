# FinePrint — Launch Checklist

Follow these steps in order. You don't need to be technical — each step says
exactly where to click. Budget: ~$12 for the domain + ~$5–10 prepaid LLM
credit to start. Vercel and Stripe accounts are free.

> ⚠️ Start with Stripe in **test mode**. Only switch to live keys when you're
> ready to take real money (Step 9).

---

## 1. Buy a domain (~$12/year)

1. Go to [Namecheap](https://www.namecheap.com) or [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/).
2. Search for a name like `fineprintscan.com` (the app is codenamed "FinePrint" — pick whatever you like).
3. Buy it. You don't need any add-ons (skip the hosting/email upsells).
4. Keep the registrar tab open — you'll come back in Step 7.

## 2. Create a Vercel account (free)

1. Go to [vercel.com](https://vercel.com) → **Sign Up** → continue with GitHub.
2. That's it for now. Vercel will host the site for free.

## 3. Get the code onto GitHub and deploy it

1. Create a free [GitHub](https://github.com) account if you don't have one.
2. Create a new repository (e.g. `fineprint`), and upload the contents of the
   `fineprint/` folder (or push with git — ask your AI assistant to do this).
3. In Vercel: **Add New → Project → Import** your `fineprint` repository.
4. Click **Deploy**. Vercel gives you a live URL like `fineprint.vercel.app`.
5. Open the URL and try a scan — it runs in **demo mode** (sample contract,
   canned report) until you add an AI key in Step 5.

## 4. Create a Stripe account (free)

1. Go to [stripe.com](https://stripe.com) → **Start now**, complete signup.
2. Toggle **Test mode** ON (top-right of the dashboard) while setting up.

### 4a. Get your API keys (test mode first)

1. Dashboard → **Developers → API keys**.
2. Copy the **Publishable key** (`pk_test_…`) and the **Secret key** (`sk_test_…`).
   You'll paste these into Vercel later. Never share the secret key.

### 4b. Create the two products

1. Dashboard → **Product catalogue → Create product**.
2. Product 1:
   - Name: `Single scan`
   - Price: `$5`, **One-time**
   - Copy the **Price ID** (`price_…`) — you'll need it.
3. Product 2:
   - Name: `Unlimited scans`
   - Price: `$29`, **Recurring → Monthly**
   - Copy the **Price ID** (`price_…`).

### 4c. Set up the webhook

1. Dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://YOUR-DOMAIN/api/webhook` (use your Vercel URL for now, e.g. `https://fineprint.vercel.app/api/webhook`).
3. Select events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.deleted`.
4. Click **Add endpoint**, then **Reveal** the **Signing secret** (`whsec_…`) and copy it.

## 5. Get an LLM API key (~$5–10 prepaid)

The scanner calls an AI model to analyze contracts. Without a key the app
stays in demo mode.

1. Go to [platform.openai.com](https://platform.openai.com) → sign up.
2. **Billing → Add funds**: add **$5–10** prepaid credit (pay-as-you-go; each scan costs a fraction of a cent).
3. **API keys → Create new secret key**. Copy it — it starts with `sk-` and is shown only once.
4. (Optional) You can use any OpenAI-compatible provider instead — see `.env.example` for `LLM_API_BASE_URL` / `LLM_MODEL`.

## 6. Add environment variables in Vercel

1. Vercel → your project → **Settings → Environment Variables**.
2. Add each of these (select **Production**, **Preview**, and **Development**), then **Save**:

   | Variable | Value | Where you got it |
   |---|---|---|
   | `LLM_API_KEY` | `sk-…` | Step 5 |
   | `STRIPE_SECRET_KEY` | `sk_test_…` (test for now) | Step 4a |
   | `STRIPE_PRICE_SINGLE` | `price_…` ($5 one-time) | Step 4b |
   | `STRIPE_PRICE_MONTHLY` | `price_…` ($29/mo) | Step 4b |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_…` | Step 4c |
   | `APP_URL` | `https://your-vercel-url.vercel.app` | Step 3 |

3. After saving, **redeploy**: Vercel → **Deployments → ⋯ → Redeploy**.

## 7. Turn on payments in the code (one-time)

Payments ship stubbed. To activate:

1. In the repo, run `npm install stripe` (ask your AI assistant).
2. Open `api/checkout.js` and `api/webhook.js` and uncomment the blocks marked `TODO` (the instructions are in the comments).
3. In `api/webhook.js`, implement the credit-granting TODOs — at minimum, decide how you track who paid (e.g. a simple database or even a spreadsheet to start; ask your AI assistant to wire your choice).
4. Commit, push → Vercel redeploys automatically.

## 8. Connect your domain

1. Vercel → your project → **Settings → Domains → Add** → enter your domain from Step 1.
2. Vercel shows you DNS records to add. Go back to your registrar (Step 1) → DNS settings:
   - Add the `A` record (`76.76.21.21`) for `@`, and/or the `CNAME` (`cname.vercel-dns.com`) for `www`, exactly as Vercel instructs.
3. Wait up to a few hours for DNS to propagate. Vercel will show the domain as active.
4. Update the `APP_URL` env var to `https://yourdomain.com` and redeploy (Step 6.3).

## 9. Go live checklist

- [ ] Test a full purchase in **Stripe test mode** (use card `4242 4242 4242 4242`).
- [ ] Confirm the webhook fires: Stripe → Developers → Webhooks → your endpoint shows `200`.
- [ ] Scan a real contract with your own LLM key; confirm a live (non-demo) report.
- [ ] In Stripe, toggle **test mode OFF**. Replace the three test values in Vercel env vars with the **live** keys (`pk_live_…`/`sk_live_…`, live price IDs, live webhook secret). Redeploy.
- [ ] Waitlist: the built-in signup form currently stores emails in a temporary server file, which **does not persist on Vercel**. Before launch, connect a real provider — easiest: [Buttondown](https://buttondown.com) or [ConvertKit](https://convertkit.com) (both free to start) — and replace the file write in `api/waitlist.js` (marked `TODO`). Ask your AI assistant to do this.
- [ ] Read the disclaimer on the site once more — it says FinePrint is not a law firm and not legal advice. Keep it.

## 10. Ongoing costs (rough)

| Item | Cost |
|---|---|
| Domain | ~$12/year |
| Vercel hosting | $0 (free tier) |
| Stripe | $0 + ~2.9% + 30¢ per sale (only when you sell) |
| LLM usage | fractions of a cent per scan (~$5–10 credit lasts months at MVP volume) |

That's the whole launch. The $100 budget covers it many times over.
