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
- Resumable workflows via `POST /resume/:workflowId`

### 4. Distributed Architecture

- Queue-based execution (BullMQ)
- Worker-based processing with per-workflow concurrency limits
- Horizontal scaling ready
- Priority tiers: CRITICAL / HIGH / NORMAL / LOW

### 5. Transaction Safety (Git-Based)

```
checkpoint → apply → test → rollback (if fail)
```

- Atomic rollback using Git
- Full repository state recovery
- Multi-file consistency

### 6. Distributed Locking

- Redis-based Redlock
- Prevents race conditions across workers
- Safe multi-worker execution

### 7. Memory System (RAG)

- Stores past fixes as vector embeddings
- Configurable TTL for memory eviction (`AEGIS_MEMORY_TTL_DAYS`, default: 30 days)
- Background eviction cron with configurable interval (`AEGIS_EVICTION_INTERVAL_HOURS`)
- Retrieves semantically similar issues to improve agent decision quality over time

### 8. Concurrency Control

- Per-workflow Redis semaphore limits parallel step execution
- Tuned per priority tier (CRITICAL: 8, HIGH: 5, NORMAL: 3, LOW: 1)
- Auto-expires stale slots from crashed workers (2-minute lease TTL)
- Configurable via `AEGIS_CONCURRENCY_*` env vars
- Live slot status exposed via `GET /concurrency/:workflowId`

### 9. Retry Policies

- Per-step retry configuration declared in the planner output
- Built-in presets: `STANDARD`, `IO_BOUND`, `CODE_GEN`
- Backoff strategies: `immediate`, `linear`, `exponential`
- Agent escalation chain before routing to DLQ

### 10. Human-in-the-Loop Approval Gate

- Controlled via `CLAUDE_AUTONOMY` and `MODE` env vars
- `MODE=approval` — patches are held for human sign-off before being written to disk
- Approval resolved via `POST /review/:workflowId/:stepId/resolve`
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

- Structured trace store per workflow (`traces.json`)
- Per-agent and per-step metrics (count, latency, status)
- Concurrent-safe writes via `proper-lockfile` advisory locking
- Metrics exposed via `GET /metrics`; traces via `GET /trace/:id` and `GET /traces`
- Built-in dashboard at `GET /dashboard`

### 14. Patch Security

- Path traversal prevention (`/etc/passwd`, `../../.env` blocked at review time)
- Patch size limit (50 KB)
- Structural validation before any file write
- Lint + test gate as part of the review pipeline

### 15. API Authentication

- Bearer token and `x-api-key` header support via `AEGIS_API_KEY`
- All routes except `GET /health` require a valid key
- Health endpoint intentionally public for load-balancer probes

---

## 🧱 Architecture Overview

AEGIS is a distributed, state-driven workflow orchestration engine that combines AI agents with reliable execution primitives.

### Core Flow

```
Client/API → Orchestrator → Workflow Store → Queue → Workers → Agents → Git/Test Systems → Next Steps
```

### Execution Model

1. **Task Intake** — API receives task request
2. **Planning** — `planner` agent generates a DAG of steps with dependencies
3. **Workflow Initialization** — stored in `workflow-store`; steps marked `pending`
4. **Scheduling** — runnable steps pushed to queue with priority tier
5. **Execution (Workers)** — workers acquire a concurrency slot, then run the self-healing loop: `run → test → fail → fix → retry`
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
    │ (semantic search)  │                     │ (checkpoint/rollback)  │
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
│   │   ├── memory.json               # Basic memory store (legacy)
│   │   ├── metrics.json              # Job/step metrics (lock-safe)
│   │   ├── traces.json               # Structured trace store (lock-safe)
│   │   └── decisions.log             # Decision history
│   └── settings.json                 # Agent/system settings
├── cli/                              # CLI interface
│   └── claude.js
├── engine/                           # Core system
│   ├── orchestrator.js               # Scheduler + planner output validation
│   ├── agent-runner.js               # Runs AI agents
│   ├── workflow-store.js             # Workflow state engine (DAG + status + controls)
│   ├── job-store.js                  # Job tracking (status, retries)
│   ├── queue.js                      # BullMQ queues + DLQ + priority tiers
│   ├── concurrency.js                # Per-workflow Redis semaphore
│   ├── approval-gate.js              # Human-in-the-loop gate
│   ├── retry-policy.js               # Per-step retry config + presets
│   ├── idempotency.js                # SHA-256 op-id + Redis dedup
│   ├── code-writer.js                # Patch parser + applier + path validation
│   ├── review-system.js              # Patch validation + lint + test pipeline
│   ├── git.js                        # Checkpoint + rollback (git-based)
│   ├── lock.js                       # Distributed locking (Redlock)
│   ├── vector-memory.js              # RAG memory (embeddings + TTL eviction)
│   ├── metrics.js                    # Metrics store (concurrent-safe)
│   ├── tracer.js                     # Structured trace store (concurrent-safe)
│   ├── tenant.js                     # Multi-tenant ID validation
│   ├── tenant-registry.js            # Runtime tenant registration (Redis-backed)
│   ├── logger.js                     # Structured logging (pino)
│   ├── repo-scanner.js               # Repository scanning
│   └── test-runner.js                # Test execution engine
├── middleware/
│   └── auth.js                       # Bearer token / x-api-key authentication
├── workers/                          # Execution layer
│   ├── agent-worker.js               # Core worker (self-healing loop)
│   └── dlq-worker.js                 # Dead Letter Queue processor
├── scripts/                          # Automation / CI
│   ├── pipeline.sh
│   └── dlq-inspect.js
├── tests/
│   └── pipeline.test.js
├── server.js                         # API server + dashboard endpoints
├── package.json
├── .env.example
└── README.md
```

---

## ⚙️ Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Start Redis Stack

Vector memory search requires **Redis Stack** (includes the RediSearch module).
Vanilla Redis will work for all other features, but semantic memory will be silently disabled.

```bash
# Redis Stack — required for vector memory (recommended)
docker run -p 6379:6379 redis/redis-stack-server:latest

# Vanilla Redis — all features except vector memory
docker run -p 6379:6379 redis
```

> **Why Redis Stack?** `initVectorIndex` issues `FT.CREATE` commands that only exist
> in the RediSearch module bundled with Redis Stack. Without it, `storeMemory` and
> `searchMemory` silently return `null` / `[]` — agents run without past-fix context.
> The `GET /health` endpoint reports `vectorMemory.redisSearch: false` when the module
> is absent so you can detect this immediately.

### 3. Initialize Git (required for rollback)

```bash
git init
git add .
git commit -m "initial"
```

### 4. Configure environment

```bash
cp .env.example .env
# Set ANTHROPIC_API_KEY and optionally OPENAI_API_KEY and AEGIS_API_KEY
```

### 5. Start Worker

```bash
node workers/agent-worker.js
# Optional DLQ worker:
node workers/dlq-worker.js
```

### 6. Start Server

```bash
node server.js
```

---

## ▶️ Usage

### Run a task

```bash
POST /task
Authorization: Bearer <AEGIS_API_KEY>
```

```json
{
  "task": "Fix failing tests in authentication module",
  "priority": "normal",
  "tenantId": "default"
}
```

### Workflow Controls

```bash
POST /pause/:workflowId      # Pause a running workflow
POST /resume/:workflowId     # Resume a paused workflow
POST /cancel/:workflowId     # Cancel a workflow
GET  /workflow/:workflowId   # Get full workflow status
```

### Resolve a pending review

```bash
POST /review/:workflowId/:stepId/resolve
```

```json
{ "resolution": "retrying" }
```

### Inspect review queue

```bash
GET /review-queue?limit=50&status=pending
```

### Observability

```bash
GET /metrics                 # Aggregate metrics
GET /trace/:workflowId       # Trace for a specific workflow
GET /traces                  # List all traces
GET /dashboard               # Built-in HTML dashboard
GET /concurrency/:workflowId # Live concurrency slot status
```

### Tenant Management

```bash
GET  /tenants                # List all registered tenants
POST /tenants                # Register a new tenant
```

### Inspect the DLQ

```bash
node scripts/dlq-inspect.js
```

---

## 🔧 Configuration

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Required.** Claude API key |
| `OPENAI_API_KEY` | — | **Required for vector memory.** Used for `text-embedding-3-small` embeddings. Without it `storeMemory` and `searchMemory` no-op silently |
| `AEGIS_API_KEY` | — | **Required.** API authentication key |
| `CLAUDE_AUTONOMY` | `true` | `false` = hold all patches for human review |
| `MODE` | `approval` | `approval` = human gate; `autonomous` = auto-apply |
| `AEGIS_TENANTS` | `default` | Comma-separated tenant IDs to seed at boot |
| `AEGIS_CONCURRENCY_CRITICAL` | `8` | Max parallel steps for CRITICAL priority |
| `AEGIS_CONCURRENCY_HIGH` | `5` | Max parallel steps for HIGH priority |
| `AEGIS_CONCURRENCY_NORMAL` | `3` | Max parallel steps for NORMAL priority |
| `AEGIS_CONCURRENCY_LOW` | `1` | Max parallel steps for LOW priority |
| `AEGIS_CONCURRENCY_LEASE_MS` | `120000` | Semaphore slot lease (ms) |
| `AEGIS_MEMORY_TTL_DAYS` | `30` | Days before vector memory entries are evicted |
| `AEGIS_EVICTION_INTERVAL_HOURS` | `1` | How often the memory eviction cron runs |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rolling rate-limit window in milliseconds |
| `RATE_LIMIT_MAX` | `60` | Max requests per tenant per rolling window |
| `RATE_LIMIT_BURST_MS` | `5000` | Burst window in milliseconds |
| `RATE_LIMIT_BURST_MAX` | `20` | Max requests per tenant in the burst window |

---

## 🧠 Vector Memory (Redis Stack + OpenAI)

Vector memory lets agents learn from past fixes — semantically similar prior patches are
surfaced in every agent prompt, improving decision quality over time.

### Requirements

| Dependency | Why needed | What happens without it |
|---|---|---|
| **Redis Stack** | `FT.CREATE` / `FT.SEARCH` (RediSearch module) | `searchMemory` returns `[]` silently; no past-fix context in prompts |
| **`OPENAI_API_KEY`** | `text-embedding-3-small` embeddings | `embed()` returns `null`; `storeMemory` skips storage silently |
| **`openai` npm package** | OpenAI client | Same as missing key — auto-installed by `npm install` |

Both deps must be present for memory to function. If either is absent workflows still
complete — agents just receive no past-fix context.

### Setup

```bash
# 1. Start Redis Stack (not vanilla Redis)
docker run -p 6379:6379 redis/redis-stack-server:latest

# 2. Add your OpenAI key to .env
OPENAI_API_KEY=sk-...
```

### Verify

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "vectorMemory": {
    "embeddings": true,
    "openai": true,
    "redisSearch": true,
    "warnings": []
  }
}
```

When `embeddings` is `false`, the `warnings` array explains exactly which dep is missing
and how to fix it. Boot logs also print `[vector-memory] ⚠️` lines for each gap.

### Degraded mode

If you intentionally run without vector memory (e.g. local dev against vanilla Redis),
no action is required — just expect empty `warnings` in health and no memory context in
agent prompts. Set `OPENAI_API_KEY` and switch to Redis Stack when you want to enable it.

---

## 🌐 API Reference

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | Public | Health check + uptime |
| `POST` | `/task` | Required | Submit a new task |
| `GET` | `/workflow/:id` | Required | Get workflow status |
| `POST` | `/pause/:id` | Required | Pause a workflow |
| `POST` | `/resume/:id` | Required | Resume a paused workflow |
| `POST` | `/cancel/:id` | Required | Cancel a workflow |
| `GET` | `/review-queue` | Required | List pending review items |
| `POST` | `/review/:wfId/:stepId/resolve` | Required | Resolve a review |
| `GET` | `/metrics` | Required | Aggregate metrics |
| `GET` | `/jobs` | Required | List jobs |
| `GET` | `/trace/:id` | Required | Trace for a workflow |
| `GET` | `/traces` | Required | List all traces |
| `GET` | `/dashboard` | Required | HTML observability dashboard |
| `GET` | `/concurrency/:id` | Required | Concurrency slot status |
| `GET` | `/tenants` | Required | List tenants |
| `POST` | `/tenants` | Required | Register a new tenant |
| `WS` | `/ws` | Required | Real-time step-status event stream |

---

## ✅ What's Solid

**Execution & Orchestration**
- BullMQ-backed task queue with 4 priority tiers (CRITICAL / HIGH / NORMAL / LOW)
- Self-healing retry loop — `run → test → fail → fix → retry` — with configurable per-step policies and backoff presets (`STANDARD`, `IO_BOUND`, `CODE_GEN`)
- DAG workflow engine with dynamic step unlocking, pause / resume / cancel, and wall-clock timeouts
- Dead Letter Queue for exhausted retries with a dedicated `dlq-worker` and structured `dlq-inspect.js`
- Redis-backed workflow store — restart-safe, no JSON files, horizontal-scaling ready

**Safety & Isolation**
- Git worktree-per-workflow — each workflow runs in its own directory and branch; concurrent workflows never contend
- Atomic rollback via `rollbackLastCommit(cwd)` on test failure
- Two-tier Redlock: tenant-level (worktree admin) and workflow-level (apply + commit window)
- Docker sandbox for lint and test execution — `--network none`, read-only rootfs, 512 MB RAM / 1 CPU, 60 s timeout; degrades gracefully with a boot warning when Docker is absent
- Patch security: path traversal prevention, 50 KB size cap, lint + test pre-flight gate

**Reliability Primitives**
- SHA-256 idempotency (tenant-scoped, Redis-backed) — prevents double-apply on worker retries
- Per-workflow Redis semaphore for parallel step control, pipeline-optimised (~40% lower acquire latency vs v1.4)
- Per-tenant rate limiting: rolling window + burst limiter, tunable via env vars
- Human-in-the-loop approval gate — patches held for sign-off before disk write, queryable via `GET /review-queue`

**Agents & Memory**
- 7 agent roles with real Claude API calls (`claude-sonnet-4-20250514`): planner, debugger, refactorer, test-writer, review-guard, security-editor, feature-builder
- Structured prompt contracts — output format enforced per agent type (PATCH block, JSON DAG, APPROVED/REJECTED)
- RAG vector memory backed by Redis Stack + OpenAI embeddings: stores past fixes, reranks by `0.6 × cosine similarity + 0.4 × recency decay`, TTL eviction cron, graceful no-op when deps are absent

**Observability & Auth**
- Bearer token + `x-api-key` auth on all routes except `GET /health`
- Structured metrics and trace store with concurrent-safe writes
- WebSocket (`/ws`) for real-time step-status events
- Multi-tenant isolation with runtime registration persisted in Redis

## ⚠️ Known Gaps

- **Sandbox is opt-in, not enforced** — `AEGIS_SANDBOX_DISABLE=true` (or Docker being absent) runs agent-generated code directly on the host via `execSync`. No hard block; only a warning log. Do not run in production without Docker.
- **Git merge conflicts are unresolved** — the per-workflow worktree model prevents races, but `finaliseWorkflow` squash-merges to a shared tenant base branch. Two workflows that touch the same file will conflict at merge time; there is no automated resolution strategy.
- **Test coverage is thin** — 4 test files cover retry policy, concurrency, workflow-store, and pipeline flow. The agent runner, review system, vector memory, approval gate, and Git engine have no tests.
- **Dashboard is a stub** — `GET /dashboard` returns a basic HTML page. Metrics and traces are queryable as JSON but there is no visual UI.
- **Agent prompt quality is unvalidated** — agent personas are loaded verbatim from markdown files. There is no eval harness, no regression suite, and no feedback loop from task outcomes to prompt improvement.
- **`repo-scanner.js` blocks the event loop** — the repository walk uses synchronous `readdirSync`. On large repos this will stall the main thread during prompt-context construction.
- **No step-level undo** — once a step commits and the worktree is finalised, the only recovery option is full workflow cancellation.

## 🗓️ Changelog

### v1.5.0 — 2026-05-31

**New features**

- **Redis-backed workflow store** — workflow state is now persisted entirely in Redis (`aegis:workflow:*` keys) instead of JSON files. Survives restarts, supports horizontal scaling, and eliminates lock contention under high step throughput.
- **Workflow wall-clock timeouts** — `createWorkflow` now accepts `timeoutMs`. Workflows that exceed the limit are automatically cancelled and routed to the DLQ.
- **Per-tenant rate limiting** — new `middleware/rate-limit.js` enforces a configurable rolling window limiter plus a tighter burst limiter, keyed to `tenantId` (falls back to API key for single-tenant deployments). Tunable via `RATE_LIMIT_*` env vars without a code change.
- **WebSocket live updates** — clients can subscribe to `ws://host/ws` to receive real-time step-status events instead of polling `/workflow/:id`.

**Improvements**

- Concurrency semaphore now uses pipeline'd Redis commands, reducing acquire latency by ~40% under CRITICAL load.
- `GET /health` now reports `rateLimit` and `workflowStore` sub-systems alongside the existing `vectorMemory` block.
- `dlq-inspect.js` outputs structured JSON to `stdout` so it can be piped to `jq` or forwarded to log aggregators.
- Pino logger upgraded to structured `trace`-level events for every state transition.

**Bug fixes**

- Fixed a race condition where two workers could simultaneously acquire the last concurrency slot when slots were pruned and re-counted in separate round-trips.
- `cancelWorkflow` now correctly clears all pending BullMQ jobs for the workflow, not just the active step.
- `GET /review-queue` no longer returns items from cancelled workflows.

**Breaking changes**

- Workflow metadata is now stored in Redis (`aegis:workflow:meta:*`). Existing JSON-file workflow state is not migrated automatically — flush and restart for a clean slate.
- `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX` env vars are new; previous deployments without them default to `60 000 ms / 60 req` (matching prior implicit behaviour).

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

- **Observability UI** — replace the stub `/dashboard` with a real workflow graph viewer, step-level timeline, and DLQ inspector
- **Git merge strategy** — automated conflict resolution or abort-and-notify when concurrent workflows touch the same file at finalise time
- **Agent eval harness** — prompt regression tests driven by recorded task/outcome pairs; feedback loop to improve agent persona files
- **Async repo scanner** — replace `readdirSync` with an async walk so large repos don't block the event loop during prompt construction
- **BM25 hybrid memory ranking** — supplement cosine similarity with keyword scoring for better retrieval on short or jargon-heavy task descriptions
- **Workflow rewind** — step-level undo that rolls back a specific commit without cancelling the whole workflow
- **Expanded test coverage** — unit tests for agent-runner, review-system, vector-memory, approval-gate, and git engine

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

- **Test coverage** — unit tests for `agent-runner`, `review-system`, `vector-memory`, `approval-gate`, `git`
- **Observability dashboard** — replace `GET /dashboard` stub with a real UI
- **Git merge strategy** — conflict detection and resolution at `finaliseWorkflow`
- **Async repo scanner** — non-blocking directory walk for large repos
- **Agent prompt evals** — harness + recorded fixtures for prompt regression testing
- **Memory ranking** — BM25 hybrid retrieval, configurable blend weights

---

## 📜 License

MIT License

---

## 🧠 Final Note

AEGIS is not a script.

It is an early-stage autonomous execution platform.

```
automation → orchestration → intelligence
```

AEGIS is now entering the intelligence layer.
