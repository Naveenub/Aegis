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

## 🆕 What's New in v1.4.0

- **Per-tenant rate limiting** — dual-layer rolling-window + burst limiter with per-tenant key isolation; all limits configurable via env vars
- **Concurrency test coverage** — full unit test suite for `concurrency.js` covering slot acquisition, limit enforcement, stale pruning, and timeout paths (Redis fully mocked)
- **Dual-layer burst protection** — `taskRateLimiter` middleware now chains a 5-second burst cap (default 20 req/5s) before the rolling window limiter
- **Rate limit env config** — `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_BURST_MS`, `RATE_LIMIT_BURST_MAX` are all runtime-tunable without code changes
- **RFC 6585 rate limit headers** — `RateLimit-*` standard headers returned; legacy `X-RateLimit-*` disabled
- **Pipeline test suite** — `tests/pipeline.test.js` covering end-to-end workflow execution paths

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

### 16. Per-Tenant Rate Limiting *(new in v1.4.0)*

- Dual-layer middleware: rolling window + short-burst cap
- Tenant-keyed throttling; falls back to API key → IP
- RFC 6585 standard `RateLimit-*` response headers
- Health endpoint always bypassed
- All thresholds configurable at runtime via env vars

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
│   ├── auth.js                       # Bearer token / x-api-key authentication
│   └── rate-limit.js                 # Per-tenant rate limiting (rolling + burst)
├── workers/                          # Execution layer
│   ├── agent-worker.js               # Core worker (self-healing loop)
│   └── dlq-worker.js                 # Dead Letter Queue processor
├── scripts/                          # Automation / CI
│   ├── pipeline.sh
│   └── dlq-inspect.js
├── tests/
│   ├── pipeline.test.js              # End-to-end pipeline tests
│   └── concurrency.test.js           # Concurrency unit tests (mocked Redis)
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

### 2. Start Redis

```bash
docker run -p 6379:6379 redis
```

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
| `ANTHROPIC_API_KEY` | — | Required. Claude API key |
| `OPENAI_API_KEY` | — | Optional. Used for vector embeddings |
| `AEGIS_API_KEY` | — | Required. API authentication key |
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
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rolling rate-limit window (ms) |
| `RATE_LIMIT_MAX` | `60` | Max requests per rolling window |
| `RATE_LIMIT_BURST_MS` | `5000` | Burst window (ms) |
| `RATE_LIMIT_BURST_MAX` | `20` | Max requests in burst window |

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

---

## ✅ What's Solid

- Distributed execution (queue + workers + priority tiers)
- Self-healing loop with configurable retry policies and agent escalation
- Workflow engine (DAG + state + pause/resume/cancel)
- Git-based atomic rollback
- Distributed locking (Redlock)
- Per-workflow concurrency control (Redis semaphore)
- Human-in-the-loop approval gate with queryable review queue
- Idempotency (SHA-256, tenant-scoped, Redis-backed)
- Multi-tenant isolation with runtime registration (Redis-persisted)
- Concurrent-safe metrics and tracing (`proper-lockfile`)
- Patch security (path traversal prevention, size limit, lint + test gate)
- Memory system (RAG with TTL eviction and background cron)
- API key authentication (Bearer token + `x-api-key`)
- Per-tenant rate limiting with burst protection (v1.4.0)
- Built-in dashboard and full observability API

## ⚠️ Known Gaps

- Workflow storage uses JSON files (not production-safe under high load)
- Git strategy lacks branch isolation per workflow
- No observability dashboard beyond the basic built-in endpoint
- Memory ranking is basic (embedding quality and reranking not tuned)

## 🧭 Roadmap — v1.5+

- Database-backed workflow store (Postgres/Redis)
- Branch-based Git execution (per-workflow branches)
- Observability dashboard (full UI)
- Improved RAG ranking and memory pruning
- Security sandboxing for code execution
- Workflow rewind (step-level undo)

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

This project is experimental but structured. Areas to contribute:

- Workflow store persistence (Postgres/Redis backend)
- Memory ranking improvements (RAG reranking)
- Observability dashboard
- Git branch-per-workflow execution strategy
- Agent prompt quality improvements

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
