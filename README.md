# AEGIS: Multi-Tenant AI Agent Orchestration Engine

> A Git-backed, DAG-driven pipeline that turns a task description into an executed, tested, reviewable patch — with Docker sandboxing, distributed locking, and per-tenant isolation.

[![Version](https://img.shields.io/badge/version-v1.7.0-blue)]()

---

## What AEGIS actually is

AEGIS is a Node.js (ESM, Node 20+) service that takes a task description, has an LLM planner decompose it into a dependency graph of steps, and executes each step through one of seven specialized agents. Each step's patch is generated, structurally validated, applied to an isolated Git worktree, linted and tested inside a Docker sandbox, and either committed or rolled back — all under Redis-backed distributed locks so multiple tenants and workflows can run concurrently without stepping on each other.

It is a REST API (`server.js`) plus a BullMQ worker pool (`workers/`), not a library you `import` and call `new AEGIS()` on.

---

## Architecture

```
POST /task ──▶ orchestrator.js (runSystem)
                 │
                 ├─ planner LLM call → JSON plan → DAG validation
                 │   (cycle detection, dependency checks, agent-name checks)
                 │
                 └─ BullMQ queue ──▶ workers/agent-worker.js
                                       │
                                       ├─ agent-runner.js: runs one of
                                       │   feature-builder | debugger | refactorer
                                       │   test-writer | security-editor
                                       │   review-guard | meta-reviewer
                                       │
                                       ├─ review-system.js: structural patch
                                       │   validation, pre-flight checks
                                       │
                                       ├─ sandbox.js: Docker-isolated
                                       │   lint + test run
                                       │
                                       ├─ git.js: per-tenant/per-workflow
                                       │   worktree, commit, or rollback
                                       │
                                       └─ approval-gate.js: hold for human
                                           review if CLAUDE_AUTONOMY=false
                                           or the step requires it

Failures ──▶ workers/dlq-worker.js: retry with backoff, escalate to
             review queue after DLQ_MAX_RETRIES, staleness alerts
```

Agent inputs include AST-level repo context (symbol tables, import/call graphs) from `repo-scanner.js`, and prior-fix context pulled from `vector-memory.js` (hybrid cosine + BM25 + recency search over OpenAI embeddings, when `OPENAI_API_KEY` is set — otherwise memory is a no-op and everything else still works).

---

## Core components (what's actually implemented)

- **DAG-based planning** (`orchestrator.js`) — LLM produces a plan as JSON tasks with `depends_on`; the engine validates structure, rejects forward references, and detects cycles via Kahn's algorithm before anything runs.
- **Seven agent types** (`agent-runner.js`) — `feature-builder`, `debugger`, `refactorer`, `test-writer`, `security-editor`, `review-guard`, and `meta-reviewer` (fallback agent used on retry attempt 3+ by `retry-policy.js`).
- **Docker sandbox** (`sandbox.js`) — every lint/test run for a generated patch executes inside a Docker container by default. If Docker is unavailable, it hard-fails the step *unless* `AEGIS_SANDBOX_MODE=local`, `AEGIS_SANDBOX_DISABLE=true`, or `CI=true` is set — each of those falls back to direct host execution with a loud warning. Never leave those set in production.
- **Git-based rollback** (`git.js`) — each workflow gets its own worktree and branch; steps commit or `rollbackLastCommit`/`revertStepCommit`; `finaliseWorkflow()` merges and can rebase-and-retry on conflicts (`AEGIS_MERGE_STRATEGY`).
- **Step rewind** (`POST /workflows/:workflowId/steps/:stepId/rewind`) — git-revert a specific step and reset dependent steps, with a full audit trail (`GET /workflows/:workflowId/rewind-history`).
- **Multi-tenancy** (`tenant.js`, `tenant-registry.js`, `tenant-quota.js`, `key-store.js`) — per-tenant API keys, quotas, and isolated worktrees/queues.
- **Human-in-the-loop** (`approval-gate.js`) — `CLAUDE_AUTONOMY=false` or `MODE=approval` holds every patch for review; individual steps can also set `requiresApproval`. Reviewed via `GET /review-queue` and `POST /review-queue/resolve`.
- **Vector memory** (`vector-memory.js`) — HNSW-backed store with a hybrid cosine + BM25 + recency reranker, per-tenant adaptive weight feedback, and a TTL eviction cron. Requires `OPENAI_API_KEY` for embeddings; degrades gracefully to a no-op without it.
- **Dead letter queue** (`workers/dlq-worker.js`) — exponential backoff retries (`DLQ_MAX_RETRIES`, `DLQ_BASE_DELAY_MS`), staleness sweeps, and webhook alerts.
- **Anomaly detection** (`engine/anomaly-detector.js`) — evaluates success rate, p95 latency, latency spikes, and retry rate on a fixed interval; fires sustained-breach alerts to stderr and/or a webhook.
- **Metrics** (`engine/metrics.js`) — Redis-backed windowed rollups with p50/p95/p99, exported as Prometheus text (`GET /metrics`) and OTEL-compatible JSON (`GET /metrics/json`).
- **Inbound webhooks** (`engine/webhook-receiver.js`) — GitHub/GitLab push and PR webhooks (signature-verified) can trigger workflows, filtered by branch pattern.
- **PR/MR automation** — `AEGIS_PR_PROVIDER` (github/gitlab) opens a pull/merge request after a workflow merges, targeting `AEGIS_PR_TARGET_BRANCH`.
- **SSE dashboard** (`engine/dashboard.html`, served at `GET /dashboard`) and a live event stream (`GET /events`).
- **AST-based repo intelligence** (`repo-scanner.js`) — built on `acorn`; produces symbol tables and import/call graphs to give agents accurate repo context instead of a flat file list.
- **CLI** (`cli/claude.js`) — submits a task, polls `GET /workflows/:workflowId` to a terminal state, and writes a context snapshot to `.claude/context/jobs.json` for subsequent Claude Code runs.

---

## Getting Started

### Installation

```bash
git clone https://github.com/Naveenub/aegis.git
cd aegis
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
```

### Running

```bash
# Redis is required
docker run -d -p 6379:6379 redis:latest

# API server
npm run server

# Agent worker (separate process)
npm run worker

# DLQ worker (separate process)
npm run dlq-worker

# CLI (submits one task and polls until done)
node cli/claude.js "add input validation to the login endpoint"
```

> **No Docker installed?** `sandbox.js` hard-fails by default when Docker is
> unavailable, so agents never run patches unsandboxed on your host by
> accident. For local dev without Docker, set `AEGIS_SANDBOX_MODE=local` in
> your `.env`. Never set this in production.

### Submitting a task

```bash
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AEGIS_API_KEY_DEFAULT" \
  -d '{"task": "Add input validation to the login endpoint"}'
```

```json
{ "workflowId": "wf_...", "status": "submitted" }
```

```bash
curl http://localhost:3000/workflows/wf_... \
  -H "Authorization: Bearer $AEGIS_API_KEY_DEFAULT"
```

---

## API Reference

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

---

## Configuration

Configuration is entirely environment-variable driven — see `.env.example` for the full, documented list. Highlights:

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

---

## Testing

```bash
npm test          # unit tests (vitest --project unit)
npm run test:system   # system/integration tests
npm run test:all      # everything
npm run test:coverage # with coverage
```

11 test files under `tests/` covering agent-runner, approval-gate, concurrency, the git engine, the pipeline, prompt-eval, repo-scanner, retry-policy, review-system, vector-memory, and workflow-store.

---

## Deployment

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
docker compose up -d --build
```

This starts `redis`, `server` (port 3000), `worker`, `dlq-worker`, and a rootless `dind` sidecar from a single `node:20-alpine` image (`Dockerfile`). Two things worth knowing:

- **`worker` talks to a rootless Docker-in-Docker sidecar (`dind`), not the host socket.** `sandbox.js` shells out to `docker run` for every lint/test execution; pointing `DOCKER_HOST` at the isolated rootless daemon instead of mounting `/var/run/docker.sock` means a sandbox compromise is capped at that sidecar's unprivileged UID rather than the host. For a genuinely multi-tenant/shared deployment, the next step up is a dedicated remote Docker host instead of a same-machine sidecar.
- **`server` and `worker` share a `repo` volume** so `AEGIS_REPO_ROOT`/`AEGIS_WORKTREES` resolve to the same git checkout across both processes.

No Kubernetes manifests exist yet — that's still open if you need it.

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Contact

- **GitHub Issues:** Bug reports and feature requests
- **Email:** badigernaveen2@gmail.com

Made by Naveen Badiger | [GitHub](https://github.com/Naveenub)
