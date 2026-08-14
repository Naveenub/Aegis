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
| GET | `/events` | Live SSE event stream |
