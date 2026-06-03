# 🛡️ AEGIS

> Autonomous Execution & Governance Intelligence System

AEGIS is a **distributed, self-healing AI-driven workflow engine** designed to plan, execute, validate, and repair software tasks autonomously using multi-agent intelligence.

---

## 🚀 What AEGIS Does

AEGIS takes a task and executes it end-to-end:

```text
plan → execute → test → fail → fix → retry → complete
```

It combines AI agents (planner, debugger, reviewer), workflow orchestration (DAG-based execution), self-correcting loops, distributed workers, Git-based transactional safety, and a vector memory system that learns from past fixes.

---

## 🧠 Core Capabilities

### 1. Autonomous Execution

- Multi-agent system (planner, debugger, reviewer, refactorer, security-editor, test-writer, meta-reviewer)
- Task decomposition into executable steps
- Agent-driven patch generation with structural validation

### 2. Self-Healing System

```
run → test → fail → fix → retry (max 3)
```

- Automatic debugging on failure
- Error-aware retries with configurable backoff
- Escalation agent chain before DLQ routing
- Dead Letter Queue for unrecoverable failures

### 3. Workflow Engine (DAG)

- Step dependency tracking (`dependsOn`)
- State transitions: `pending → running → completed / failed / needs-review`
- Dynamic scheduling of unlocked steps
- Full workflow lifecycle controls: **pause**, **resume**, **cancel**
- Step-level rewind: roll back a specific committed step without cancelling the workflow

### 4. Distributed Architecture

- Queue-based execution (BullMQ)
- Worker-based processing with per-workflow concurrency limits
- Horizontal scaling ready
- Priority tiers: CRITICAL / HIGH / NORMAL / LOW

### 5. Transaction Safety (Git-Based)

```
checkpoint → apply → test → rollback (if fail)
```

- Per-workflow isolated Git worktrees — concurrent workflows never share a working directory
- Atomic rollback using `git reset --hard HEAD~1` on test failure
- Step-level `git revert` for targeted undo without rewriting history
- Multi-file consistency

### 6. Distributed Locking

- Redis-based Redlock with two lock tiers:
  - **Tenant lock** — short TTL, guards worktree creation/deletion
  - **Workflow lock** — held for apply + commit window
- Prevents race conditions across workers
- Safe multi-worker execution

### 7. Memory System (RAG)

- Stores past fixes as vector embeddings (OpenAI `text-embedding-3-small`)
- Three-way hybrid reranking: cosine similarity + BM25 keyword score + recency decay
- Configurable weights via `AEGIS_MEMORY_W_*` env vars (auto-normalised)
- TTL eviction cron with configurable interval
- Retrieves semantically similar past fixes to improve agent decision quality over time

### 8. Concurrency Control

- Per-workflow Redis semaphore limits parallel step execution
- Tuned per priority tier (CRITICAL: 8, HIGH: 5, NORMAL: 3, LOW: 1)
- Auto-expires stale slots from crashed workers (2-minute lease TTL)
- Configurable via `AEGIS_CONCURRENCY_*` env vars
- Live slot status exposed via `GET /concurrency/:workflowId`

### 9. Retry Policies

- Per-step retry configuration declared in the planner output
- Built-in presets: `STANDARD`, `IO_BOUND`, `CODE_GEN`, `REVIEW`
- Backoff strategies: `immediate`, `linear`, `exponential`
- Agent escalation chain before routing to DLQ

### 10. Human-in-the-Loop Approval Gate

- Controlled via `CLAUDE_AUTONOMY` and `MODE` env vars
- `MODE=approval` — patches are held for human sign-off before being written to disk
- Approval resolved via `POST /review-queue/resolve`
- Review queue queryable via `GET /review-queue`
- Steps re-queued after approval; idempotency check prevents double-application

### 11. Idempotency

- SHA-256 operation IDs keyed to `workflowId + stepId + patch`
- Redis-backed, tenant-scoped idempotency store
- Prevents duplicate patch application on worker retries

### 12. Multi-Tenant Support

- Tenant isolation across all shared state (queues, locks, idempotency, metrics)
- `tenantId` validated and propagated through every engine layer
- Runtime tenant registration via `POST /tenants` (Redis-persisted, survives restarts)
- Default tenant (`default`) for single-tenant deployments

### 13. Observability

- Structured trace store per workflow/span in Redis (concurrent-safe)
- Per-agent and per-step metrics (count, latency, status)
- Prometheus text export (`GET /metrics`) and OTEL JSON export (`GET /metrics/json`)
- Built-in dashboard at `GET /dashboard` — 1 000-line single-page app polling live API endpoints

### 14. Patch Security

- Path traversal prevention (`/etc/passwd`, `../../.env` blocked at review time)
- Patch size limit (50 KB)
- Structural validation before any file write
- Lint + test gate as part of the review pipeline
- Docker sandbox for lint and test execution — no network, read-only rootfs, 512 MB / 1 CPU, 60 s timeout

### 15. API Authentication

- Bearer token and `x-api-key` header support
- Per-tenant runtime key management (create, rotate, revoke via API — no restart)
- Env-var fallback (`AEGIS_API_KEY_{TENANTID}`) for existing deployments
- All routes except `GET /health` require a valid key
- `AEGIS_SKIP_AUTH=1` bypasses key checks in dev mode

### 16. Anomaly Detection

- In-process metric evaluation loop (configurable cadence, default 60 s)
- Five built-in rules: `low_success_rate_5m`, `critical_success_rate`, `high_p95_latency`, `latency_spike`, `high_retry_rate`
- Hysteresis window (`ANOMALY_SUSTAINED_MS`, default 2 min) prevents alert storms on transient spikes
- Fires structured JSON alerts to stderr and POSTs to `AEGIS_ALERT_WEBHOOK` when set
- Stores alerts in Redis with TTL; surfaced via `GET /anomalies`
- All thresholds configurable via env vars

### 17. SSE Live-Push Stream

- `GET /events` streams live metrics and recent workflows to the dashboard via Server-Sent Events
- Eliminates polling — replaces the 15 s `setInterval` in the dashboard UI
- Pushes a full snapshot immediately on connect, then every 4 s
- Keepalive ping every 25 s prevents nginx / load-balancer timeouts
- Cleans up automatically on client disconnect

### 18. Webhook Receiver (GitHub / GitLab)

- `POST /webhooks/github` and `POST /webhooks/gitlab` translate SCM events into workflow submissions
- Supported events: GitHub `push` + `pull_request` (opened / synchronize / reopened); GitLab `Push Hook` + `Merge Request Hook`
- HMAC-SHA256 signature verification for GitHub; shared-secret token for GitLab
- Branch filtering via `AEGIS_WEBHOOK_BRANCH_FILTER` glob patterns (default: accept all)
- No API-key auth — authenticated via HMAC/token inside the handler

### 19. Remote Push & PR / MR Creation

- After `finaliseWorkflow()` succeeds, optionally pushes the merged branch to a configured remote (`AEGIS_GIT_REMOTE`)
- Opens a Pull Request (GitHub) or Merge Request (GitLab) against a target branch
- Provider configured via `AEGIS_PR_PROVIDER` (`github` | `gitlab` | `none`)
- Push is skipped entirely when `AEGIS_GIT_REMOTE` is unset (local-only mode)

---

## 🧱 Architecture Overview

```
Client/API → Orchestrator → Workflow Store → Queue → Workers → Agents → Git/Test Systems → Next Steps
```

### Execution Model

1. **Task Intake** — API receives task request
2. **Planning** — `planner` agent generates a DAG of steps with dependencies
3. **Workflow Initialization** — stored in Redis; steps marked `pending`
4. **Scheduling** — runnable steps pushed to queue with priority tier
5. **Execution (Workers)** — workers acquire a concurrency slot, then run the self-healing loop
6. **State Transition** — step marked `completed` or `failed`; next steps unlocked dynamically
7. **Failure Handling** — retries (per policy), agent escalation, Git rollback, DLQ

---

## 🧠 ASCII Architecture

```
                           ┌──────────────────────────┐
                           │        Client/API        │
                           │       (server.js)        │
                           └────────────┬─────────────┘
                                        │
                                        ▼
                           ┌──────────────────────────┐
                           │      Orchestrator        │
                           │  (planner + scheduler)   │
                           └────────────┬─────────────┘
                                        │
                                        ▼
                           ┌──────────────────────────┐
                           │     Workflow Store       │
                           │ (state + dependencies)   │
                           └────────────┬─────────────┘
                                        │
                                        ▼
                           ┌──────────────────────────┐
                           │         Queue            │
                           │   (BullMQ + Priority)    │
                           └───────┬────────┬─────────┘
                                   │        │
                  ┌────────────────┘        └────────────────┐
                  ▼                                          ▼
        ┌──────────────────────┐                  ┌──────────────────────┐
        │        Worker        │                  │        Worker        │
        │   (agent-worker.js)  │                  │   (agent-worker.js)  │
        └──────────┬───────────┘                  └──────────┬───────────┘
                   │                                         │
                   ▼                                         ▼
        ┌──────────────────────┐                  ┌──────────────────────┐
        │    Agent Runner      │                  │    Agent Runner      │
        │ (planner/debug/etc.) │                  │ (review/debug/etc.)  │
        └────┬─────────────────┘                  └──────────┬───────────┘
             │                                               │
    ┌────────▼───────────┐                     ┌─────────────▼──────────┐
    │  Concurrency Gate  │                     │   Approval Gate        │
    │  (Redis semaphore) │                     │ (human-in-the-loop)    │
    └────────┬───────────┘                     └─────────────┬──────────┘
             │                                               │
    ┌────────▼───────────┐                     ┌─────────────▼──────────┐
    │   Vector Memory    │                     │      Git Engine        │
    │ (semantic search)  │                     │  (worktree + revert)   │
    └────────┬───────────┘                     └─────────────┬──────────┘
             │                                               │
             ▼                                               ▼
       ┌──────────────┐                              ┌──────────────┐
       │ Test Runner  │                              │ Lock System  │
       │  + Tracer    │                              │  (Redlock)   │
       └──────────────┘                              └──────────────┘

                           ┌──────────────────────────┐
                           │   Dead Letter Queue      │
                           │   (failed isolation)     │
                           └──────────────────────────┘
```

---

## 📁 Project Structure

```
aegis/
├── .claude/                          # AI system configuration
│   ├── agents/                       # Agent role definitions
│   │   ├── planner.md
│   │   ├── debugger.md
│   │   ├── refactorer.md
│   │   ├── test-writer.md
│   │   ├── review-guard.md
│   │   ├── security-editor.md
│   │   ├── feature-builder.md
│   │   └── meta-reviewer.md
│   ├── context/                      # Persistent context
│   │   └── jobs.json                 # Recent job snapshot (written by CLI on run)
│   │       # memory.json / decisions.log removed — superseded by Redis
│   │       # Agent memory: engine/vector-memory.js (storeMemory → Redis hashes + HNSW)
│   │       # Decision history: engine/workflow-store.js (workflow state → Redis)
│   └── settings.json                 # Agent/system settings
├── cli/                              # CLI interface
│   └── claude.js                     # Submits task, polls to completion, writes jobs.json
├── engine/                           # Core system
│   ├── orchestrator.js               # Scheduler + planner output validation
│   ├── agent-runner.js               # Runs AI agents via Anthropic SDK
│   ├── workflow-store.js             # Workflow state engine (DAG + rewind + audit)
│   ├── job-store.js                  # Job tracking (status, retries)
│   ├── queue.js                      # BullMQ queues + DLQ + priority tiers
│   ├── concurrency.js                # Per-workflow Redis semaphore
│   ├── approval-gate.js              # Human-in-the-loop gate
│   ├── retry-policy.js               # Per-step retry config + presets
│   ├── idempotency.js                # SHA-256 op-id + Redis dedup
│   ├── code-writer.js                # Patch parser + applier + path validation
│   ├── review-system.js              # Patch validation + lint + test pipeline
│   ├── git.js                        # Worktree management + commit + revert
│   ├── lock.js                       # Distributed locking (Redlock)
│   ├── vector-memory.js              # RAG memory (embeddings + BM25 + TTL)
│   ├── metrics.js                    # Prometheus + OTEL metrics store
│   ├── tracer.js                     # Structured trace store (Redis-backed)
│   ├── sandbox.js                    # Docker isolation for lint + test
│   ├── tenant.js                     # Multi-tenant ID validation
│   ├── tenant-registry.js            # Runtime tenant registration (Redis-backed)
│   ├── logger.js                     # Structured logging (pino)
│   ├── repo-scanner.js               # Async repository scanning
│   ├── lint-runner.js                # ESLint runner (sandboxed)
│   ├── test-runner.js                # Vitest runner (two-pass, sandboxed)
│   ├── prompt-eval.js                # Agent output quality evaluation
│   └── dashboard.html                # Single-page observability UI
├── middleware/
│   ├── auth.js                       # Bearer token / x-api-key + runtime key store
│   └── rate-limit.js                 # Per-tenant rolling + burst rate limiter
├── workers/                          # Execution layer
│   ├── agent-worker.js               # Core worker (self-healing loop)
│   └── dlq-worker.js                 # Dead Letter Queue processor + stale sweep
├── scripts/
│   ├── pipeline.sh                   # CI/CD automation script
│   └── dlq-inspect.js                # CLI: inspect DLQ for a tenant
├── tests/
│   ├── agent-runner.test.js
│   ├── approval-gate.test.js
│   ├── concurrency.test.js
│   ├── git-engine.test.js
│   ├── pipeline.test.js
│   ├── prompt-eval.test.js
│   ├── repo-scanner.test.js
│   ├── retry-policy.test.js
│   ├── review-system.test.js
│   ├── vector-memory.test.js
│   └── workflow-store.test.js
├── server.js                         # API server + all route handlers
├── package.json
├── .env.example
├── eslintrc.cjs
└── README.md
```

---

## ⚙️ Setup

### 1. Prerequisites

- **Node.js ≥ 20**
- **Redis Stack** (for vector memory) or vanilla Redis (all other features)
- **Docker** (for sandboxed lint + test execution)
- **Git** repo initialized at your project root

### 2. Install dependencies

```bash
npm install
```

### 3. Start Redis Stack

Vector memory search requires **Redis Stack** (includes the RediSearch module).
Vanilla Redis works for all other features; semantic memory is silently disabled.

```bash
# Redis Stack — required for vector memory (recommended)
docker run -p 6379:6379 redis/redis-stack-server:latest

# Vanilla Redis — all features except vector memory
docker run -p 6379:6379 redis
```

### 4. Initialize Git (required for rollback and worktrees)

```bash
git init
git add .
git commit -m "initial"
```

### 5. Configure environment

```bash
cp .env.example .env
# Required: set ANTHROPIC_API_KEY and AEGIS_API_KEY_DEFAULT
# Optional: set OPENAI_API_KEY to enable vector memory
```

### 6. Start processes

```bash
# API server
node server.js

# Agent worker (at least one required)
node workers/agent-worker.js

# DLQ worker (optional but recommended)
node workers/dlq-worker.js
```

---

## ▶️ Usage

### Submit a task

```bash
curl -X POST http://localhost:3000/task \
  -H "Authorization: Bearer <AEGIS_API_KEY_DEFAULT>" \
  -H "Content-Type: application/json" \
  -d '{"task": "Fix failing tests in authentication module"}'
```

Response:
```json
{ "workflowId": "...", "status": "submitted" }
```

### Workflow controls

```bash
# Resume a paused workflow
POST /resume
{ "workflowId": "..." }

# Cancel a workflow
POST /cancel
{ "workflowId": "...", "reason": "no longer needed" }

# Get workflow status
GET /workflows/:workflowId
```

### Step-level rewind (undo a completed step)

```bash
POST /workflows/:workflowId/steps/:stepId/rewind
{ "reason": "patch introduced a regression" }
```

Response:
```json
{ "ok": true, "workflowId": "...", "stepId": "...", "resetSteps": ["step-3", "step-4"], "commitHash": "abc123" }
```

Downstream steps that already completed as a result of the rewound step are also reset to `pending`.

### Resolve a pending review

```bash
POST /review-queue/resolve
{ "workflowId": "...", "stepId": "...", "resolution": "approved" }
```

### Inspect review queue

```bash
GET /review-queue?limit=50&status=pending
```

### Observability

```bash
GET /dashboard                    # HTML observability UI (SSE-driven, no polling)
GET /metrics                      # Prometheus text export
GET /metrics/json                 # OTEL JSON export
GET /api/metrics                  # Structured metrics (dashboard internal)
GET /traces                       # List all traces
GET /traces/:traceId              # Single workflow trace
GET /concurrency/:workflowId      # Live concurrency slot status
GET /anomalies                    # Recent anomaly alerts (last 50, newest first)
GET /events                       # SSE live-push stream (metrics + workflow updates)
```

### Tenant management

```bash
GET  /tenants                     # List all registered tenants
POST /tenants                     # Register a new tenant { tenantId, label? }
GET  /tenants/:id                 # Get tenant metadata
POST /tenants/:id/keys            # Create an API key { label?, expiresAt? }
GET  /tenants/:id/keys            # List keys (hashes only)
DELETE /tenants/:id/keys/:keyId   # Revoke a key
```

### Inspect the DLQ

```bash
node scripts/dlq-inspect.js [tenantId]
```

---

## 🔧 Configuration

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Required.** Claude API key |
| `OPENAI_API_KEY` | — | Required for vector memory (`text-embedding-3-small`) |
| `AEGIS_API_KEY_DEFAULT` | — | **Required.** API key for the default tenant |
| `PORT` | `3000` | HTTP port for the API server |
| `CLAUDE_AUTONOMY` | `true` | `false` = hold all patches for human review |
| `MODE` | `autonomous` | `approval` = human gate; `autonomous` = auto-apply |
| `AEGIS_TENANTS` | `default` | Comma-separated tenant IDs to seed at boot |
| `AEGIS_CONCURRENCY_CRITICAL` | `8` | Max parallel steps for CRITICAL priority |
| `AEGIS_CONCURRENCY_HIGH` | `5` | Max parallel steps for HIGH priority |
| `AEGIS_CONCURRENCY_NORMAL` | `3` | Max parallel steps for NORMAL priority |
| `AEGIS_CONCURRENCY_LOW` | `1` | Max parallel steps for LOW priority |
| `AEGIS_CONCURRENCY_LEASE_MS` | `120000` | Semaphore slot lease (ms) |
| `AEGIS_MEMORY_TTL_DAYS` | `30` | Days before vector memory entries are evicted |
| `AEGIS_EVICTION_INTERVAL_HOURS` | `1` | How often the eviction cron runs |
| `AEGIS_MEMORY_W_COSINE` | `0.50` | Reranker weight for cosine similarity |
| `AEGIS_MEMORY_W_BM25` | `0.30` | Reranker weight for BM25 keyword score |
| `AEGIS_MEMORY_W_RECENCY` | `0.20` | Reranker weight for recency decay |
| `AEGIS_BM25_K1` | `1.5` | BM25 term-frequency saturation |
| `AEGIS_BM25_B` | `0.75` | BM25 document-length normalisation |
| `AEGIS_IDEM_TTL_SECONDS` | `604800` | Idempotency key TTL (7 days) |
| `AEGIS_GIT_LOCK_TTL_MS` | `15000` | Per-workflow git lock TTL |
| `AEGIS_GIT_TENANT_LOCK_TTL_MS` | `10000` | Tenant-level git admin lock TTL |
| `AEGIS_SANDBOX_IMAGE` | `node:22-alpine` | Docker image for sandboxed execution |
| `AEGIS_SANDBOX_MEMORY` | `512m` | Container memory cap |
| `AEGIS_SANDBOX_CPUS` | `1` | Container CPU cap |
| `AEGIS_SANDBOX_TIMEOUT_MS` | `60000` | Container wall-clock timeout |
| `AEGIS_SANDBOX_DISABLE` | unset | `true` = run lint/test on host (dev only, never production) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rolling rate-limit window |
| `RATE_LIMIT_MAX` | `60` | Max requests per tenant per window |
| `RATE_LIMIT_BURST_MS` | `5000` | Burst window |
| `RATE_LIMIT_BURST_MAX` | `20` | Max requests per tenant in burst window |
| `DLQ_MAX_RETRIES` | `2` | DLQ retry budget before human review |
| `DLQ_BASE_DELAY_MS` | `30000` | Base DLQ retry back-off (doubles each attempt) |
| `DLQ_STALE_SWEEP_MS` | `900000` | How often the DLQ stale-item sweep runs (ms) |
| `DLQ_STALE_THRESHOLD_MS` | `3600000` | Age at which a DLQ item is considered stale |
| `AEGIS_ALERT_WEBHOOK` | unset | URL to POST structured DLQ / anomaly alerts to |
| `AEGIS_SKIP_AUTH` | unset | `1` = bypass API key checks (dev only) |
| `AEGIS_TENANT` | `default` | Tenant ID used by the CLI |
| `AEGIS_CLI_POLL_INTERVAL_MS` | `3000` | How often the CLI polls for workflow completion (ms) |
| `AEGIS_MEMORY_OVERFETCH` | `3` | KNN over-fetch multiplier for reranker recall |
| `AEGIS_MEMORY_MIN_SCORE` | `0.5` | Minimum combined quality score to surface a memory |
| `AEGIS_MEMORY_HALFLIFE_DAYS` | `7` | Recency decay half-life in days |
| `AEGIS_MEMORY_FEEDBACK_STEP` | `0.02` | Per-tenant adaptive weight nudge per feedback event |
| `AEGIS_MERGE_STRATEGY` | unset | `rebase` = rebase instead of merge at `finaliseWorkflow` |
| `AEGIS_GIT_REMOTE` | unset | Remote name or URL to push to after a successful merge |
| `AEGIS_GIT_PUSH_BRANCH` | unset | Branch pushed to remote (`__workflow__` = per-workflow branch) |
| `AEGIS_PR_PROVIDER` | `none` | `github` or `gitlab` — opens a PR/MR after push |
| `AEGIS_PR_REPO` | — | `owner/repo` (GitHub) or numeric project ID (GitLab) |
| `AEGIS_PR_TARGET_BRANCH` | `main` | Branch the PR/MR targets |
| `AEGIS_PR_TOKEN` | — | Personal access token for PR/MR creation |
| `AEGIS_WEBHOOK_SECRET_GITHUB` | — | HMAC-SHA256 secret for GitHub webhook verification |
| `AEGIS_WEBHOOK_SECRET_GITLAB` | — | Shared token for GitLab webhook verification |
| `AEGIS_WEBHOOK_BRANCH_FILTER` | `*` | Comma-separated glob patterns for branch filtering |
| `AEGIS_WEBHOOK_TENANT` | `default` | Tenant ID attributed to inbound webhook jobs |
| `ANOMALY_INTERVAL_MS` | `60000` | Anomaly detector evaluation cadence (ms) |
| `ANOMALY_SUSTAINED_MS` | `120000` | How long a threshold must be breached before an alert fires |
| `ANOMALY_SUCCESS_RATE_WARN` | `80` | 5m success rate % below which a warning fires |
| `ANOMALY_SUCCESS_RATE_CRIT` | `50` | 5m success rate % below which a critical alert fires |
| `ANOMALY_P95_WARN_MS` | `30000` | 5m p95 latency (ms) above which a warning fires |
| `ANOMALY_SPIKE_RATIO` | `3` | Ratio of 5m p95 to 1h p95 that triggers a spike alert |
| `ANOMALY_RETRY_RATE` | `0.20` | Retry fraction (retries/total) above which a warning fires |
| `ANOMALY_ALERT_TTL_S` | `86400` | Redis TTL for stored anomaly alerts (seconds) |
| `ANOMALY_MAX_STORED` | `200` | Max anomaly alerts kept in the Redis index |

---

## 🧠 Vector Memory (Redis Stack + OpenAI)

Vector memory lets agents learn from past fixes — semantically similar prior patches are
surfaced in every agent prompt, improving decision quality over time.

### Requirements

| Dependency | Why needed | What happens without it |
|---|---|---|
| **Redis Stack** | `FT.CREATE` / `FT.SEARCH` (RediSearch module) | `searchMemory` returns `[]` silently; no past-fix context in prompts |
| **`OPENAI_API_KEY`** | `text-embedding-3-small` embeddings | `embed()` returns `null`; `storeMemory` skips storage silently |
| **`openai` npm package** | OpenAI client | Auto-installed by `npm install` |

Both deps must be present for memory to function. Without them, workflows complete — agents receive no past-fix context.

### Reranking

Results are scored by a three-way blend:

```
score = w_cosine × cosine_similarity + w_bm25 × bm25_score + w_recency × recency_decay
```

Weights are configured via env vars (`AEGIS_MEMORY_W_*`) and auto-normalised to sum to 1.0. Per-tenant weights can be nudged via `recordMemoryFeedback()` to improve retrieval over time.

### Verify

```bash
curl -H "Authorization: Bearer <key>" http://localhost:3000/health
```

When `vectorMemory.embeddings` is `false`, the `warnings` array explains exactly which dep is missing.

---

## 🌐 API Reference

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | Public | Liveness check + subsystem status |
| `POST` | `/task` | Required | Submit a new task |
| `POST` | `/resume` | Required | Resume a paused workflow |
| `POST` | `/cancel` | Required | Cancel a workflow |
| `GET` | `/workflows` | Required | List workflows (filterable) |
| `GET` | `/workflows/:id` | Required | Get workflow status + steps |
| `POST` | `/workflows/:id/steps/:stepId/rewind` | Required | Rewind a completed step |
| `GET` | `/workflows/:id/rewind-history` | Required | Rewind audit trail |
| `GET` | `/concurrency/:id` | Required | Live concurrency slot status |
| `GET` | `/review-queue` | Required | List pending review items |
| `POST` | `/review-queue/resolve` | Required | Resolve a review item |
| `GET` | `/jobs` | Required | List jobs (tenant-scoped) |
| `GET` | `/jobs/:jobId` | Required | Get a single job |
| `GET` | `/traces` | Required | List all traces |
| `GET` | `/traces/:id` | Required | Get a single trace |
| `GET` | `/metrics` | Optional | Prometheus text export |
| `GET` | `/metrics/json` | Optional | OTEL JSON export |
| `GET` | `/api/metrics` | Required | Structured metrics (dashboard) |
| `GET` | `/dashboard` | Required | HTML observability UI |
| `GET` | `/tenants` | Required | List tenants |
| `POST` | `/tenants` | Required | Register a tenant |
| `GET` | `/tenants/:id` | Required | Get tenant metadata |
| `GET` | `/tenants/:id/keys` | Required | List API keys |
| `POST` | `/tenants/:id/keys` | Required | Create an API key |
| `DELETE` | `/tenants/:id/keys/:kid` | Required | Revoke an API key |
| `GET` | `/anomalies` | Required | Recent anomaly alerts (last 50, newest first) |
| `GET` | `/events` | Required | SSE live-push stream (metrics + workflow updates) |
| `POST` | `/webhooks/github` | HMAC sig | GitHub push / pull_request webhook |
| `POST` | `/webhooks/gitlab` | Token | GitLab Push Hook / Merge Request Hook |

---

## ✅ What's Solid

**Execution & Orchestration**
- BullMQ-backed task queue with 4 priority tiers (CRITICAL / HIGH / NORMAL / LOW)
- Self-healing retry loop — `run → test → fail → fix → retry` — with configurable per-step policies and backoff presets (`STANDARD`, `IO_BOUND`, `CODE_GEN`, `REVIEW`)
- DAG workflow engine with dynamic step unlocking, pause / resume / cancel
- Dead Letter Queue for exhausted retries with a dedicated `dlq-worker`, exponential back-off, and stale-item staleness sweep
- Redis-backed workflow store — restart-safe, no JSON files, horizontal-scaling ready

**Safety & Isolation**
- Git worktree-per-workflow — each workflow runs in its own directory and branch; concurrent workflows never contend
- Atomic rollback via `git reset --hard HEAD~1` on test failure
- Step-level `git revert` — targeted undo that preserves history for downstream steps
- Two-tier Redlock: tenant-level (worktree admin) and workflow-level (apply + commit window)
- Docker sandbox for lint and test execution — `--network none`, read-only rootfs, 512 MB RAM / 1 CPU, 60 s timeout; **hard-fails** (not silently bypasses) when Docker is absent

**Reliability Primitives**
- SHA-256 idempotency (tenant-scoped, Redis-backed) — prevents double-apply on worker retries
- Per-workflow Redis semaphore for parallel step control (~40% lower acquire latency than v1.4)
- Per-tenant rate limiting: rolling window + burst limiter, tunable via env vars
- Human-in-the-loop approval gate — patches held for sign-off before disk write

**Agents & Memory**
- 8 agent roles with real Claude API calls: planner, debugger, refactorer, test-writer, review-guard, security-editor, feature-builder, meta-reviewer
- Structured prompt contracts — output format enforced per agent type (PATCH block, JSON DAG, APPROVED/REJECTED)
- Three-way hybrid RAG memory: cosine similarity + BM25 + recency decay, with per-tenant adaptive weight feedback

**Observability & Auth**
- Bearer token + `x-api-key` auth on all protected routes; `AEGIS_SKIP_AUTH=1` bypasses for local dev
- Structured metrics and Redis-backed trace store
- 1 000-line single-page dashboard driven by SSE live-push stream (no polling)
- Multi-tenant isolation with runtime registration persisted in Redis
- DLQ webhook alerts and per-tenant stale sweep
- In-process anomaly detector with hysteresis — five built-in rules, Redis-stored alerts, `GET /anomalies`

**Integration**
- GitHub / GitLab inbound webhook receiver — push and PR/MR events trigger workflow submissions automatically
- Remote push + PR/MR creation after successful `finaliseWorkflow` (`AEGIS_PR_PROVIDER=github|gitlab`)

**Test Coverage**
- 11 test files: workflow-store, approval-gate, concurrency, retry-policy, review-system, repo-scanner, prompt-eval, agent-runner, vector-memory, pipeline, git-engine — all with proper vi mocking, no real network or file I/O

---

## ⚠️ Known Gaps

- **`engine/git.js` is a copy-paste accident in the source zip** — the file is byte-for-byte identical to `workers/agent-worker.js`. The real git module (implementing `ensureWorkflowBranch`, `commitChanges`, `rollbackLastCommit`, `revertStepCommit`, `finaliseWorkflow`, `removeWorkflowWorktree`) needs to be the fixed version from the rewind fix session. Every git operation will throw `"not a function"` at runtime until it is replaced.
- **Git merge conflicts are unresolved** — `finaliseWorkflow` merges the per-workflow branch into the tenant base. Two workflows that touch the same file will conflict at merge time; there is no automated resolution strategy.
- **`prompt-eval.js` writes to the filesystem** — `recordEvalResult` appends to `.claude/context/eval-history.jsonl` via `fs.appendFileSync`. Under concurrent workers this can corrupt the file, the same class of bug that was previously fixed in `tracer.js` and `job-store.js`.
- **`scripts/pipeline.sh` has two bugs** — it polls `/workflow/$WORKFLOW_ID` (singular) instead of `/workflows/:id` (plural), and checks `.status === "submitted"` which was not returned by the old server. Both are fixed by the updated `server.js` (which now returns `{ workflowId, status: 'submitted' }`), but the poll URL in `pipeline.sh` still needs to be corrected to `/workflows/`.
- **Agent prompt quality is unvalidated** — agent personas are loaded verbatim from markdown files. There is no eval harness, no regression suite, and no feedback loop from task outcomes to prompt improvement.

---

## 🗓️ Changelog

### v1.5.2 — 2026-06-03

**New features**

- **In-process anomaly detector** — evaluates live metrics on a configurable cadence (default 60 s) with hysteresis; fires alerts to stderr, `AEGIS_ALERT_WEBHOOK`, and Redis. Five built-in rules: success rate warning/critical, p95 latency warning, latency spike, and high retry rate. Surfaced via `GET /anomalies`.
- **SSE live-push stream** — `GET /events` pushes metrics and recent workflow snapshots to the dashboard via Server-Sent Events every 4 s, replacing the previous 15 s polling loop. Includes a 25 s keepalive ping.
- **Inbound webhook receiver** — `POST /webhooks/github` and `POST /webhooks/gitlab` translate push and PR/MR events into workflow submissions. HMAC-SHA256 verification for GitHub; shared-token verification for GitLab. Branch filtering via `AEGIS_WEBHOOK_BRANCH_FILTER`.
- **Remote push + PR/MR creation** — after `finaliseWorkflow()` succeeds, optionally pushes the merged branch to a remote and opens a Pull Request (GitHub) or Merge Request (GitLab) via `AEGIS_PR_PROVIDER`.

---

### v1.5.1 — 2026-06-01

**Fixes**

- Removed unused `ws` and `proper-lockfile` dependencies from `package.json` — neither package is imported anywhere in the codebase.
- `POST /task` now returns `{ workflowId, status: 'submitted' }` so `scripts/pipeline.sh` correctly detects a successful submission. Previously it returned the raw `workflowId` string.
- Added `GET /concurrency/:workflowId` route that was documented but missing from `server.js`.
- Added step rewind routes (`POST /workflows/:id/steps/:stepId/rewind` and `GET /workflows/:id/rewind-history`) to `server.js`.
- `eslintrc.cjs` updated with real rules matching the codebase (`no-unused-vars`, `no-console` warn exceptions, `prefer-const`).
- `.env.example` expanded with all missing variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PORT`, `AEGIS_TENANTS`, `CLAUDE_AUTONOMY`, `MODE`, DLQ configuration, CLI polling, and sandbox vars.

---

### v1.5.0 — 2026-05-31

**New features**

- **Redis-backed workflow store** — workflow state is now persisted entirely in Redis instead of JSON files.
- **Per-tenant rate limiting** — rolling window + burst limiter via `middleware/rate-limit.js`.
- **Docker sandbox** — lint and test run inside an isolated container; hard-fail (not silent bypass) when Docker is absent.
- **Three-way hybrid memory reranking** — cosine similarity + BM25 + recency decay with configurable blend weights and per-tenant adaptive feedback.
- **Step-level rewind** — `revertStepCommit` + `rewindStep` allow rolling back a specific committed step without cancelling the workflow.

**Improvements**

- Concurrency semaphore uses pipelined Redis commands (~40% lower acquire latency).
- DLQ worker adds exponential back-off retries before routing to human review, plus a periodic stale-item sweep.
- `cli/claude.js` now polls to completion and writes `jobs.json` context after each run.

**Bug fixes**

- Fixed race condition where two workers could simultaneously acquire the last concurrency slot.
- `cancelWorkflow` now clears all pending BullMQ jobs, not just the active step.
- `GET /review-queue` no longer returns items from cancelled workflows.

---

### v1.4.x (previous)

- Multi-tenant isolation with runtime registration
- Human-in-the-loop approval gate
- Idempotency layer (SHA-256, Redis-backed)
- Patch security (path traversal, size limit, lint+test gate)
- Vector memory with TTL eviction and background cron
- API key authentication

---

## 🧭 Roadmap — v1.6+

- **Git module fix** — replace the accidentally duplicated `engine/git.js` with a real implementation so the apply → commit → test → merge path works end-to-end
- **Git merge strategy** — automated conflict resolution or abort-and-notify when concurrent workflows touch the same file at finalise time
- **`pipeline.sh` poll URL fix** — correct `/workflow/` → `/workflows/` so CI works out of the box
- **`prompt-eval.js` Redis migration** — move `eval-history.jsonl` writes to Redis, eliminating the last file-based concurrent-write hazard
- **Agent eval harness** — prompt regression tests driven by recorded task/outcome pairs
- **Observability improvements** — step-level timeline, DAG graph viewer, DLQ inspector in the dashboard
- **Async repo scanner everywhere** — `repo-scanner.js` is async but a few call sites still use the sync variant

---

## ⚠️ Reality Check

AEGIS is:

✅ Autonomous execution engine
✅ Self-healing workflow system
✅ Distributed orchestration platform
✅ Production-ready execution primitives (locking, idempotency, concurrency, approval)

AEGIS is NOT:

❌ Fully autonomous company
❌ Zero-error system
❌ Replacement for human engineers

---

## 🤝 Contributing

This project is experimental but structured. Highest-value areas:

- **Fix `engine/git.js`** — the copy-paste accident is the single biggest blocker to end-to-end functionality
- **Fix `scripts/pipeline.sh`** — correct the poll URL from `/workflow/` to `/workflows/`
- **Migrate `prompt-eval.js`** — move `eval-history.jsonl` writes to Redis
- **Git merge strategy** — conflict detection and resolution at `finaliseWorkflow`
- **Agent prompt evals** — harness + recorded fixtures for prompt regression testing

---

## 📜 License

MIT License — see [LICENSE](./LICENSE)

---

## 🧠 Final Note

AEGIS is not a script.

It is an early-stage autonomous execution platform.

```
automation → orchestration → intelligence
```

AEGIS is now entering the intelligence layer.
