---
id: configuration
title: Configuration
sidebar_position: 5
---

# Configuration

Configuration is entirely environment-variable driven — see `.env.example` in the repo for the full, documented list. Highlights:

```bash
ANTHROPIC_API_KEY=...          # required — all agent LLM calls
OPENAI_API_KEY=...             # optional — enables vector memory embeddings
AEGIS_API_KEY_DEFAULT=...      # per-tenant API key(s)
PORT=3000
AEGIS_TENANTS=default          # tenants registered at boot
CLAUDE_AUTONOMY=true           # false = every patch held for human review
AEGIS_SANDBOX_MODE=            # 'local' to bypass Docker (dev only, never prod)
AEGIS_MERGE_STRATEGY=rebase    # or 'flag'
DLQ_MAX_RETRIES=2
```

Vector memory reranking, concurrency limits per priority tier, DLQ backoff, anomaly thresholds, and webhook secrets are all separately tunable — see `.env.example`.

## Data retention

| Variable | Default | Purpose |
| --- | --- | --- |
| `AEGIS_RETENTION_JOBS_DAYS` | `90` | Platform default retention for job results (1–365). |
| `AEGIS_RETENTION_WORKFLOWS_DAYS` | `90` | Platform default retention for finished workflows (1–365). |
| `AEGIS_MEMORY_TTL_DAYS` | `30` | Platform default for vector memory. |

Tenants override these with `PUT /tenants/:id/retention` (`jobsDays`, `workflowsDays`, `memoryDays`, `zeroRetention`). Purging is done by the daily `npm run retention:sweep` job (k8s CronJob `12-retention-sweep-cronjob.yaml`, Render cron `aegis-retention-sweep`); nothing is purged unless it is deployed. See [Compliance](./compliance.md).
