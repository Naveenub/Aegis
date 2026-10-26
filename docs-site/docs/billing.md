---
id: billing
title: Billing & Pricing
sidebar_position: 8
---

# Billing & Pricing

AEGIS bills a **base subscription per tier plus metered overage**. Stripe is the system of record; AEGIS meters usage, reports it to Stripe, and gates access on payment status.

## Tiers

Each tier includes a monthly allowance (calendar month, UTC). Usage beyond it is billed per unit. Separately, hard **quotas** cap concurrency and daily volume regardless of billing (abuse prevention).

| | Starter | Pro | Enterprise |
|---|---|---|---|
| Workflow runs / month | 500 | 5,000 | unlimited |
| Agent steps / month | 5,000 | 50,000 | unlimited |
| Tokens / month | 2M | 20M | unlimited |
| Sandbox minutes / month | 300 | 3,000 | unlimited |
| Active workflows | 3 | 10 | 50 |
| Workflows / day | 20 | 100 | 1,000 |
| Queued jobs | 50 | 200 | 2,000 |

The source of truth is `engine/billing/tiers.js`. Prices are set in Stripe (see below), not in code.

## How metering works

1. Every billable action is written once to the append-only `usage_events` table in Postgres (`workflow_run`, `agent_step`, `tokens`, `sandbox_minutes`). Recording is best-effort and never fails a workflow.
2. `npm run billing:flush` (hourly CronJob in `k8s/10-billing-flush-cronjob.yaml`) sums unreported rows per tenant and event type and sends one **Stripe Billing Meter event** each. The event identifier is derived from the row-id range, so a retry is deduplicated by Stripe.
3. Stripe invoices the graduated metered price: the tier's allowance is the free band, overage is charged above it.

`GET /tenants/:id/billing` shows the current tier and usage vs. allowance. It is informational and never blocks requests.

## Stripe setup (one time)

Use a test-mode key first.

```bash
STRIPE_SECRET_KEY=sk_test_... \
BASE_USD_STARTER=... BASE_USD_PRO=... BASE_USD_ENTERPRISE=... \
OVERAGE_USD_WORKFLOW_RUN=... OVERAGE_USD_AGENT_STEP=... \
OVERAGE_USD_TOKENS=... OVERAGE_USD_SANDBOX_MINUTES=... \
node scripts/stripe-setup.js          # add --dry-run to preview
```

It creates 4 Meters, 3 base prices and 12 per-tier metered prices, and prints the env lines (`STRIPE_PRICE_{TIER}`, `STRIPE_PRICE_{TIER}_{EVENT}`). Add them, plus `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `BILLING_RETURN_URL`, to your environment or Kubernetes secret.

Then in the Stripe dashboard:

- Add a webhook endpoint `POST /webhooks/stripe` subscribed to `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated` and `customer.subscription.deleted`.
- Enable the **Customer portal** (Settings → Billing).

Meter event names default to `aegis_workflow_run`, `aegis_agent_step`, `aegis_tokens`, `aegis_sandbox_minutes`; override with `STRIPE_METER_EVENT_<TYPE>`.

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

The tenant starts `pending`. Confirm the first payment in your frontend with Stripe.js using `clientSecret`; Stripe's `invoice.paid` webhook then sets the tenant `active`. Until then every authenticated call returns **402**.

| Tenant status | Set by | API access |
|---|---|---|
| `pending` | signup | blocked (402) |
| `active` | `invoice.paid`, subscription `active`/`trialing` | allowed |
| `suspended` | `invoice.payment_failed`, subscription `past_due`/`unpaid`/`canceled`/deleted | blocked (402) |
| *(unset)* | design-partner and env-seeded tenants | allowed |

Static env API keys are never gated.

## Recovering a suspended account

`POST /billing/portal` (works while suspended or pending) returns a Stripe-hosted portal URL where the tenant updates their card or pays the open invoice. A successful payment fires `invoice.paid` and re-activates the account.

## Cleanup of unpaid signups

`npm run billing:cleanup` (daily CronJob `k8s/11-pending-cleanup-cronjob.yaml`) removes tenants that stayed `pending` for more than 48 hours: it deletes the Stripe customer, revokes keys and removes the tenant. If a live subscription is found (a missed webhook), the tenant is reconciled to `active` instead. Flags: `--hours=<n>`, `--dry-run`.

## Design partners (manual billing)

`npm run onboard <tenantId> "<label>" [tier]` registers a tenant and key with no Stripe involvement, for invoicing via a Payment Link. These tenants have no status and are never gated or cleaned up.
