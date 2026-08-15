# Changelog

## v2.0.0

Major release. This snapshot summarizes AEGIS as it stands today — a Git-backed, DAG-driven multi-agent orchestration engine.

### Highlights

- **DAG-based planning** — LLM-produced JSON plans validated for cycles (Kahn's algorithm), forward references, and agent-name correctness before execution.
- **Seven specialized agents** — `feature-builder`, `debugger`, `refactorer`, `test-writer`, `security-editor`, `review-guard`, and `meta-reviewer` (retry fallback).
- **Docker-sandboxed execution** — every lint/test run happens in an isolated container by default; explicit opt-out only via `AEGIS_SANDBOX_MODE=local`, `AEGIS_SANDBOX_DISABLE=true`, or `CI=true`.
- **Git-based rollback and step rewind** — per-workflow worktrees/branches, `rollbackLastCommit`/`revertStepCommit`, rebase-and-retry merge strategy, and a `POST /steps/:stepId/rewind` endpoint with full audit trail.
- **Multi-tenancy** — per-tenant API keys, quotas, and isolated worktrees/queues.
- **Human-in-the-loop approvals** — `CLAUDE_AUTONOMY=false` or per-step `requiresApproval`, resolved via `/review-queue`.
- **Vector memory** — Redis Stack (FT.SEARCH) hybrid cosine + BM25 + recency reranking with per-tenant adaptive weights; degrades gracefully without `OPENAI_API_KEY`.
- **Dead letter queue** — exponential backoff, staleness sweeps, webhook alerts.
- **Anomaly detection** — success rate, p95 latency, latency spikes, and retry rate monitored on a fixed interval.
- **Metrics** — Prometheus text export (`/metrics`) and OTEL-compatible JSON (`/metrics/json`).
- **Inbound webhooks + PR/MR automation** — signature-verified GitHub/GitLab triggers; auto-opens PRs/MRs on `github`/`gitlab`/`bitbucket` after merge.
- **SSE dashboard and live event stream** (`/dashboard`, `/events`).
- **AST-based repo intelligence** via `acorn`-built symbol tables and import/call graphs.
- **CLI** (`cli/claude.js`) for submitting tasks and polling to completion.
- **Kubernetes manifests** under `k8s/` for namespace, Redis, PVC, server/worker/dlq-worker deployments, HPA, and ingress.

### Known limitations

- `npm run test:system` requires a live Docker daemon and Redis Stack; it won't run in sandboxed/CI environments without those.
- The local-HNSW vector memory fallback (plain Redis, no Stack) is single-process only and desyncs memory across a multi-container deployment. `initVectorIndex()` now fails fast with a descriptive error in that case unless `AEGIS_ALLOW_HNSW_FALLBACK=true` is explicitly set (single-process/dev only) — see `engine/vector-memory.js`.

---

_Earlier version history is not tracked in this changelog; this entry establishes the baseline going forward._
