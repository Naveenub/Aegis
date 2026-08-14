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
