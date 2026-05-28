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
- Retrieves semantically similar issues
- Improves agent decision quality over time

### 8. Concurrency Control

- Per-workflow Redis semaphore limits parallel step execution
- Tuned per priority tier (CRITICAL: 8, HIGH: 5, NORMAL: 3, LOW: 1)
- Auto-expires stale slots from crashed workers (2-minute lease TTL)
- Configurable via `AEGIS_CONCURRENCY_*` env vars

### 9. Retry Policies

- Per-step retry configuration declared in the planner output
- Built-in presets: `STANDARD`, `IO_BOUND`, `CODE_GEN`
- Backoff strategies: `immediate`, `linear`, `exponential`
- Agent escalation chain before routing to DLQ

### 10. Human-in-the-Loop Approval Gate

- Controlled via `CLAUDE_AUTONOMY` and `MODE` env vars
- `MODE=approval` — patches are held for human sign-off before being written to disk
- Approval resolved via `POST /review/:workflowId/:stepId/resolve`
- Steps re-queued after approval; idempotency check prevents double-application

### 11. Idempotency

- SHA-256 operation IDs keyed to `workflowId + stepId + patch`
- Redis-backed, tenant-scoped idempotency store
- Prevents duplicate patch application on worker retries

### 12. Multi-Tenant Support

- Tenant isolation across all shared state (queues, locks, idempotency, metrics)
- `tenantId` validated and propagated through every engine layer
- Default tenant (`default`) for single-tenant deployments

### 13. Observability

- Structured trace store per workflow (`traces.json`)
- Per-agent and per-step metrics (count, latency, status)
- Concurrent-safe writes via `proper-lockfile` advisory locking
- Metrics exposed via API for dashboard consumption

### 14. Patch Security

- Path traversal prevention (`/etc/passwd`, `../../.env` blocked at review time)
- Patch size limit (50 KB)
- Structural validation before any file write
- Lint + test gate as part of the review pipeline

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
│   ├── workflow-store.js             # Workflow state engine (DAG + status)
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
│   ├── vector-memory.js              # RAG memory (embeddings + search)
│   ├── metrics.js                    # Metrics store (concurrent-safe)
│   ├── tracer.js                     # Structured trace store (concurrent-safe)
│   ├── tenant.js                     # Multi-tenant ID validation
│   ├── logger.js                     # Structured logging (pino)
│   ├── repo-scanner.js               # Repository scanning
│   └── test-runner.js                # Test execution engine
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
# Set ANTHROPIC_API_KEY and optionally OPENAI_API_KEY
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
```

```json
{
  "task": "Fix failing tests in authentication module"
}
```

### Resume a workflow

```bash
POST /resume/:workflowId
```

### Resolve a pending review

```bash
POST /review/:workflowId/:stepId/resolve
```

```json
{ "resolution": "retrying" }
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
| `OPENAI_API_KEY` | — | Optional. Used for embeddings |
| `CLAUDE_AUTONOMY` | `true` | `false` = hold all patches for human review |
| `MODE` | `approval` | `approval` = human gate; `autonomous` = auto-apply |
| `AEGIS_TENANTS` | `default` | Comma-separated tenant IDs |
| `AEGIS_CONCURRENCY_CRITICAL` | `8` | Max parallel steps for CRITICAL priority |
| `AEGIS_CONCURRENCY_HIGH` | `5` | Max parallel steps for HIGH priority |
| `AEGIS_CONCURRENCY_NORMAL` | `3` | Max parallel steps for NORMAL priority |
| `AEGIS_CONCURRENCY_LOW` | `1` | Max parallel steps for LOW priority |
| `AEGIS_CONCURRENCY_LEASE_MS` | `120000` | Semaphore slot lease (ms) |

---

## ✅ What's Solid

- Distributed execution (queue + workers + priority tiers)
- Self-healing loop with configurable retry policies and agent escalation
- Workflow engine (DAG + state + resumable)
- Git-based atomic rollback
- Distributed locking (Redlock)
- Per-workflow concurrency control (Redis semaphore)
- Human-in-the-loop approval gate
- Idempotency (SHA-256, tenant-scoped, Redis-backed)
- Multi-tenant isolation across all shared state
- Concurrent-safe metrics and tracing (`proper-lockfile`)
- Patch security (path traversal prevention, size limit, lint + test gate)
- Memory system (RAG foundation)

## ⚠️ Known Gaps

- Workflow storage uses JSON files (not production-safe under high load)
- Git strategy lacks branch isolation per workflow
- No pause/cancel controls
- No observability dashboard (metrics and traces are API-only)
- Memory ranking is basic (embedding quality and reranking not tuned)

## 🧭 Roadmap — v1.1+

- Database-backed workflow store (Postgres/Redis)
- Branch-based Git execution (per-workflow branches)
- Workflow controls (pause / cancel / rewind)
- Observability dashboard
- Improved RAG ranking and memory pruning
- Security sandboxing for code execution

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
