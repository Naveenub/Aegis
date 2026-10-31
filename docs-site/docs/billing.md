---
id: billing
title: Billing & Pricing
sidebar_position: 8
---

# Billing & Pricing

AEGIS bills a **base subscription per tier plus metered overage**. Stripe is the system of record; AEGIS meters usage, reports it to Stripe, and gates access on payment status.

## Tiers

Paid tiers include a monthly allowance (calendar month, UTC). Usage beyond it is billed per unit. The **free tier** has no subscription, so its allowance is a **hard limit**, not an overage band. Separately, hard **quotas** cap concurrency and daily volume regardless of billing (abuse prevention).

| | Free | Starter | Pro | Enterprise |
|---|---|---|---|---|
| Workflow runs / month | 25 | 500 | 5,000 | unlimited |
| Agent steps / month | 250 | 5,000 | 50,000 | unlimited |
| Input tokens / month | 300K | 1.5M | 15M | unlimited |
| Output tokens / month | 40K | 300K | 3M | unlimited |
| Sandbox minutes / month | 30 | 300 | 3,000 | unlimited |
| Platform-key LLM spend cap / month | $2 | $15 | $150 | $1,500 |
| Active workflows | 1 | 3 | 10 | 50 |
| Workflows / day | 3 | 20 | 100 | 1,000 |
| Queued jobs | 5 | 50 | 200 | 2,000 |

The source of truth is `engine/billing/tiers.js`. Prices are set in Stripe (see below), not in code.

> The free tier's numbers are **provisional**: they are sized so a free tenant costs you at most its spend cap, but they have not been checked against measured cost per workflow. Run the pricing steps below before relying on them.

### Free tier

No card, no Stripe objects. `POST /signup` with `tier: "free"` (the signup page's default) creates an **active** tenant and a working API key immediately. Limits are enforced, not billed:

- Workflow runs and sandbox minutes are checked when a workflow starts (`engine/billing/free-tier.js`); at the limit the workflow is refused with a `QuotaExceededError` naming the dimension (`freeTier:workflow_run`, `freeTier:sandbox_minutes`).
- Tokens and agent steps are bounded by the tier's hard LLM spend cap (`spend-guard.js`).
- A tenant with **no stored tier** (design partners, env-seeded tenants) is never treated as free.

There is no email verification on free signup. Signup is rate-limited and requires the isolated sandbox runner, but if free-tier abuse becomes a problem, verify the email before issuing the key.

## How metering works

1. Every billable action is written once to the append-only `usage_events` table in Postgres (`workflow_run`, `agent_step`, `tokens_in`, `tokens_out`, `sandbox_minutes`). Recording is best-effort and never fails a workflow.
2. `npm run billing:flush` (hourly CronJob in `k8s/10-billing-flush-cronjob.yaml`) sums unreported rows per tenant and event type and sends one **Stripe Billing Meter event** each. The event identifier is derived from the row-id range, so a retry is deduplicated by Stripe.
3. Stripe invoices the graduated metered price: the tier's allowance is the free band, overage is charged above it.

`GET /tenants/:id/billing` shows the current tier and usage vs. allowance. It is informational and never blocks requests.

## Setting prices from measured cost

Prices are not defaulted anywhere. Derive them from what workflows actually cost on your deployment:

```bash
# 1. Measure real workflows (needs DATABASE_URL; run against a deployment that has run real work)
npm run billing:measure-cost -- --days=30 --exclude-tenants=loadtest --out=measured-cost.json

# 2. Turn the measurement into prices and check every tier, free included
TARGET_GROSS_MARGIN=0.6 AEGIS_COST_SANDBOX_PER_MIN=0.002 \
  npm run billing:propose-pricing -- --measured=measured-cost.json
```

`measure-cost` reads `usage_events` and reports LLM cost per workflow (mean, p50, p90, p99) from input and output tokens. Sandbox events carry no workflow id, so sandbox time is reported as window total ÷ workflows. Workflows with no recorded platform-key tokens (BYOK, or failed before any call) are excluded and counted, not averaged in as $0. `propose-pricing` refuses to run on fewer than 30 workflows.

`propose-pricing` prints, and changes nothing:

- **Overage per unit** = unit cost ÷ (1 − margin), rounded up. Token costs default to the Claude list price (`AEGIS_COST_INPUT_PER_MTOK` / `AEGIS_COST_OUTPUT_PER_MTOK`); sandbox cost per minute is your infra cost and is required. `workflow_run` and `agent_step` overage is $0 unless you give a platform overhead (`AEGIS_COST_PER_RUN_USD`, `AEGIS_COST_PER_STEP_USD`), because LLM cost is carried by the token meters.
- **Base price floor** = cost of using the whole allowance ÷ (1 − margin). It holds the margin even when a tenant uses everything; charging less subsidises the allowance. Enterprise has no finite allowance, so its floor is built from the spend cap: quote it individually.
- **Warnings** where a tier's own numbers don't hold up: a token allowance that runs out before the advertised runs do, a spend cap below the cost of the whole allowance (its overage could never bill), a free tier whose runs at p90 cost exceed its cap.

Paste the `BASE_USD_*` / `OVERAGE_USD_*` lines it prints into the next step.

## Stripe setup (one time)

Use a test-mode key first. The free tier has no Stripe prices, so only starter, pro and enterprise are provisioned.

```bash
STRIPE_SECRET_KEY=sk_test_... \
BASE_USD_STARTER=... BASE_USD_PRO=... BASE_USD_ENTERPRISE=... \
OVERAGE_USD_WORKFLOW_RUN=... OVERAGE_USD_AGENT_STEP=... \
OVERAGE_USD_TOKENS_IN=... OVERAGE_USD_TOKENS_OUT=... OVERAGE_USD_SANDBOX_MINUTES=... \
node scripts/stripe-setup.js          # add --dry-run to preview
```

It creates 5 Meters, 3 base prices and 15 per-tier metered prices (paid tiers only), and prints the env lines (`STRIPE_PRICE_{TIER}`, `STRIPE_PRICE_{TIER}_{EVENT}`). Add them, plus `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `BILLING_RETURN_URL`, to your environment or Kubernetes secret.

Then in the Stripe dashboard:

- Add a webhook endpoint `POST /webhooks/stripe` subscribed to `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated` and `customer.subscription.deleted`. The last two also drive plan changes (below).
- Enable the **Customer portal** (Settings → Billing).

Input and output tokens are separate meters because output costs 5x input ($3/M vs $15/M for Claude Sonnet). `stripe-setup.js` refuses overage prices below provider cost, and below `AEGIS_COST_SANDBOX_PER_MIN` if you set it (`ALLOW_BELOW_COST=1` to override).

Meter event names default to `aegis_workflow_run`, `aegis_agent_step`, `aegis_tokens_in`, `aegis_tokens_out`, `aegis_sandbox_minutes`; override with `STRIPE_METER_EVENT_<TYPE>`.

## Signup and payment gating

`POST /signup` (unauthenticated, rate-limited) takes `{ email, tenantId, label?, tier? }` and returns:

```json
{
  "tenantId": "acme", "tier": "pro",
  "apiKey": "…shown once…", "keyId": "k_…",
  "status": "pending",
  "clientSecret": "pi_…_secret_…",
  "stripeCustomerId": "cus_…", "stripeSubscriptionId": "sub_…"
}
```

### Built-in signup page

The server ships a signup page at `/get-started` (the landing page's pricing buttons link to it). It calls `POST /signup`, shows the API key once, mounts Stripe's Payment Element with `clientSecret`, and confirms the payment. It reads the publishable key from `GET /signup/config`, so set `STRIPE_PUBLISHABLE_KEY` (`pk_...`) on the server; without it the page falls back to a contact-us message. The page is served from the same origin as the API, so no CORS setup is needed. Plan prices on the page are read from your Stripe base prices (`STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO`) and cached for 5 minutes; if Stripe can't be reached the page just omits them. Only `starter` and `pro` are offered self-serve; `enterprise` stays sales-led.

If you build your own frontend instead, the tenant starts `pending`. Confirm the first payment with Stripe.js using `clientSecret`; Stripe's `invoice.paid` webhook then sets the tenant `active`. Until then every authenticated call returns **402**.

| Tenant status | Set by | API access |
|---|---|---|
| `pending` | signup | blocked (402) |
| `active` | `invoice.paid`, subscription `active`/`trialing` | allowed |
| `suspended` | `invoice.payment_failed`, subscription `past_due`/`unpaid`/`canceled`/deleted | blocked (402) |
| *(unset)* | design-partner and env-seeded tenants | allowed |

Static env API keys are never gated.

## Tax (GST / VAT / sales tax)

Off by default. Set `AEGIS_TAX_MODE`:

- `stripe` — Stripe Tax (`automatic_tax`). Needs Stripe Tax set up with your registrations. In India Stripe Tax only supports non-resident sellers (IGST on OIDAR), so it does **not** cover an India-based seller.
- `gst` — India-based seller. Set `AEGIS_TAX_HOME_STATE` (ISO 3166-2:IN, e.g. `KA`) and run `scripts/stripe-setup.js` to create the CGST 9% / SGST 9% / IGST 18% rates (`STRIPE_TAXRATE_IN_*`). Same-state customers get CGST+SGST, other states IGST, customers outside India no tax (zero-rating exports needs a valid LUT).

When on, `POST /signup` and `POST /billing/plan` (free → paid) require `billingAddress: { country, state? }` (state required for `IN`) and accept an optional `taxId` (GSTIN). Existing paid customers keep the rates already on their subscription; add your GSTIN and invoice details in the Stripe dashboard. Verify rates and invoices in test mode, and confirm the 18% classification and USD invoicing with your tax adviser.

## Status and SLA

`GET /status` is a public dependency check (503 on outage). Point an external status page or uptime monitor at it; hosting the page on the service itself defeats its purpose. `monitoring/aegis-alerts.yml` has availability SLO and burn-rate alerts based on a blackbox probe of it. The SLA terms (target, credits, exclusions) are a commercial and legal decision and are not in `landing/terms.html`, which still says "as is".

## Changing plan

`POST /billing/plan` (API key) with `{ "tier": "free" | "starter" | "pro", "email"?: string }`:

| From → to | What happens | `effective` |
|---|---|---|
| free → starter/pro | New Stripe subscription; the response has a `clientSecret` to confirm with Stripe.js. The tenant **stays free and active** until the invoice is paid, then moves up. Status `202`. | `on_payment` |
| starter → pro | Items swapped now; the prorated base difference is invoiced immediately. A failed payment raises and changes nothing. | `now` |
| pro → starter | Scheduled with a subscription schedule; the tenant keeps Pro until the paid period ends. | `period_end` |
| starter/pro → free | Subscription cancelled at period end; the tenant then lands on the free tier, active (not suspended). | `period_end` |
| same tier | Clears a pending downgrade or cancel. | `now` |

The response reports `currentTier` (what the tenant runs on right now), `targetTier` and `effectiveAt`. The stored tier and quota only change when the Stripe webhook confirms it, via the `tier` stamped on the subscription's metadata, so what a tenant may use always matches what Stripe will bill. Enterprise is not self-serve, and design-partner tenants (no stored tier or Stripe customer) are billed by hand.

### Verify in Stripe test mode before going live

The plan-change requests are unit-tested against a mocked Stripe client, which proves they are well-formed, not how Stripe behaves. With a test-mode key, check once: (1) free → pro confirms and the tenant moves up; (2) pro → starter shows a schedule in the dashboard and the tier drops at the boundary; (3) starter → pro mid-cycle invoices a sensible proration, and the metered usage already reported this period is billed against the right price after the item swap; (4) paid → free lands on the free tier, active.

## Recovering a suspended account

`POST /billing/portal` (works while suspended or pending) returns a Stripe-hosted portal URL where the tenant updates their card or pays the open invoice. A successful payment fires `invoice.paid` and re-activates the account.

## Cleanup of unpaid signups

`npm run billing:cleanup` (daily CronJob `k8s/11-pending-cleanup-cronjob.yaml`) removes tenants that stayed `pending` for more than 48 hours: it deletes the Stripe customer, revokes keys and removes the tenant. If a live subscription is found (a missed webhook), the tenant is reconciled to `active` instead. Flags: `--hours=<n>`, `--dry-run`.

## Design partners (manual billing)

`npm run onboard <tenantId> "<label>" [tier]` registers a tenant and key with no Stripe involvement, for invoicing via a Payment Link. These tenants have no status and are never gated or cleaned up.
