---
id: api-reference
title: API Reference
sidebar_position: 4
---

# API Reference

Auth: `Authorization: Bearer <key>` where the key is `AEGIS_API_KEY_{TENANTID}` (or the single-tenant `AEGIS_API_KEY` fallback).

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness probe, no auth |
| POST | `/task` | Submit a task, returns `{ workflowId, status: 'submitted' }` |
| POST | `/resume` | Resume a paused workflow |
| POST | `/cancel` | Cancel a running/paused workflow |
| GET | `/workflows` | List workflows (`?status&tenantId&limit&cursor`) |
| GET | `/workflows/:workflowId` | Workflow status and step details |
| POST | `/workflows/:workflowId/steps/:stepId/rewind` | Git-revert a step, reset dependents |
| GET | `/workflows/:workflowId/rewind-history` | Rewind audit trail |
| GET | `/concurrency/:workflowId` | Current concurrency slot usage |
| GET | `/jobs`, `/jobs/:jobId` | Persisted job records |
| GET | `/traces`, `/traces/:traceId` | Workflow execution traces |
| GET | `/review-queue` | Steps held for human approval |
| POST | `/review-queue/resolve` | Approve or reject a held step |
| GET | `/metrics` | Prometheus text-format export |
| GET | `/metrics/json` | OTEL-compatible JSON export |
| GET | `/dashboard` | SSE live dashboard (HTML) |
| GET | `/anomalies` | Active anomaly alerts |
| GET/POST | `/tenants`, `/tenants/:id` | Tenant management |
| GET/POST/DELETE | `/tenants/:id/keys[/:keyId]` | Per-tenant API key management |
| GET | `/signup/config` | Public signup config: Stripe publishable key and self-serve tiers (unauthenticated; 503 if unconfigured) |
| POST | `/signup` | Self-serve signup (unauthenticated) — see [Billing](billing) |
| GET | `/tenants/:id/billing` | Tier and this month's usage vs. included allowance |
| POST | `/billing/portal` | Stripe billing-portal URL (update card, pay invoice) |
| POST | `/billing/plan` | Change plan `{ tier, email? }`: free→paid, upgrade now, downgrade / cancel at period end |
| POST | `/webhooks/stripe` | Stripe webhook (signature-verified) |
| GET | `/events` | Live SSE event stream |

## Billing status codes

`402 Payment Required` is returned by every authenticated endpoint except `/billing/portal` and `/tenants/:id/billing` when the tenant is `pending` (first payment not yet confirmed) or `suspended` (payment failed or subscription cancelled). The body includes `status`. See [Billing](billing).
