---
id: architecture
title: Core Components
sidebar_position: 3
---

# Core components (what's actually implemented)

- **DAG-based planning** (`orchestrator.js`) — LLM produces a plan as JSON tasks with `depends_on`; the engine validates structure, rejects forward references, and detects cycles via Kahn's algorithm before anything runs.
- **Seven agent types** (`agent-runner.js`) — `feature-builder`, `debugger`, `refactorer`, `test-writer`, `security-editor`, `review-guard`, and `meta-reviewer` (fallback agent used on retry attempt 3+ by `retry-policy.js`).
- **Docker sandbox** (`sandbox.js`) — every lint/test run for a generated patch executes inside a Docker container by default. If Docker is unavailable, it hard-fails the step *unless* `AEGIS_SANDBOX_MODE=local`, `AEGIS_SANDBOX_DISABLE=true`, or `CI=true` is set — each of those falls back to direct host execution with a loud warning. Never leave those set in production.
- **Git-based rollback** (`git.js`) — each workflow gets its own worktree and branch; steps commit or `rollbackLastCommit`/`revertStepCommit`; `finaliseWorkflow()` merges and can rebase-and-retry on conflicts (`AEGIS_MERGE_STRATEGY`).
- **Step rewind** (`POST /workflows/:workflowId/steps/:stepId/rewind`) — git-revert a specific step and reset dependent steps, with a full audit trail (`GET /workflows/:workflowId/rewind-history`).
- **Multi-tenancy** (`tenant.js`, `tenant-registry.js`, `tenant-quota.js`, `key-store.js`) — per-tenant API keys, quotas, and isolated worktrees/queues.
- **Human-in-the-loop** (`approval-gate.js`) — `CLAUDE_AUTONOMY=false` or `MODE=approval` holds every patch for review; individual steps can also set `requiresApproval`. Reviewed via `GET /review-queue` and `POST /review-queue/resolve`.
- **Vector memory** (`vector-memory.js`) — Redis Stack (`FT.SEARCH`) backed store with a hybrid cosine + BM25 + recency reranker, per-tenant adaptive weight feedback, and a TTL eviction cron. Requires `OPENAI_API_KEY` for embeddings; degrades gracefully to a no-op without it.
- **Dead letter queue** (`workers/dlq-worker.js`) — exponential backoff retries (`DLQ_MAX_RETRIES`, `DLQ_BASE_DELAY_MS`), staleness sweeps, and webhook alerts.
- **Anomaly detection** (`engine/anomaly-detector.js`) — evaluates success rate, p95 latency, latency spikes, and retry rate on a fixed interval; fires sustained-breach alerts to stderr and/or a webhook.
- **Metrics** (`engine/metrics.js`) — Redis-backed windowed rollups with p50/p95/p99, exported as Prometheus text (`GET /metrics`) and OTEL-compatible JSON (`GET /metrics/json`).
- **Inbound webhooks** (`engine/webhook-receiver.js`) — GitHub/GitLab push and PR webhooks (signature-verified) can trigger workflows, filtered by branch pattern.
- **PR/MR automation** — `AEGIS_PR_PROVIDER` (github/gitlab/bitbucket) opens a pull/merge request after a workflow merges, targeting `AEGIS_PR_TARGET_BRANCH`.
- **SSE dashboard** (`engine/dashboard.html`, served at `GET /dashboard`) and a live event stream (`GET /events`).
- **AST-based repo intelligence** (`repo-scanner.js`) — built on `acorn`; produces symbol tables and import/call graphs to give agents accurate repo context instead of a flat file list.
- **CLI** (`cli/claude.js`) — submits a task, polls `GET /workflows/:workflowId` to a terminal state, and writes a context snapshot to `.claude/context/jobs.json` for subsequent Claude Code runs.

See [Deployment](./deployment) for how these pieces map onto containers, or [Configuration](./configuration) for the environment variables that control them.
