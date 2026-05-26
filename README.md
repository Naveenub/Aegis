# 🛡️ AEGIS

> Autonomous Execution & Governance Intelligence System

AEGIS is a **distributed, self-healing AI-driven workflow engine** designed to plan, execute, validate, and repair software tasks autonomously using multi-agent intelligence.

---

# 🚀 What AEGIS Does

AEGIS takes a task and executes it end-to-end:

```text
plan → execute → test → fail → fix → retry → complete
```

It combines:

AI agents (planner, debugger, reviewer)
Workflow orchestration (DAG-based execution)
Self-correcting loops
Distributed workers
Git-based transactional safety
Memory (learning from past fixes)

---

## 🧠 Core Capabilities

### 1. Autonomous Execution

- Multi-agent system (planner, debugger, reviewer)
- Task decomposition into executable steps
- Agent-driven patch generation

### 2. Self-Healing System

`run → test → fail → fix → retry (max 3)`

- Automatic debugging
- Error-aware retries
- Continuous improvement loop

### 3. Workflow Engine (DAG)

- Step dependency tracking (dependsOn)
- State transitions:
  - pending → running → completed / failed
- Dynamic scheduling of next steps
- Resumable workflows

### 4. Distributed Architecture

- Queue-based execution (BullMQ)
- Worker-based processing
- Horizontal scaling ready

### 5. Transaction Safety (Git-Based)

- checkpoint → apply → test → rollback (if fail)
- Atomic rollback using Git
- Full repository state recovery
- Multi-file consistency

### 6. Distributed Locking

- Redis-based Redlock
- Prevents race conditions
- Safe multi-worker execution

### 7. Memory System (RAG)

- Stores past fixes
- Retrieves similar issues
- Improves agent decisions over time

### 8. Observability (Basic)

- Success / failure tracking
- Retry metrics
- Structured logging hooks

---

## 🧱 Architecture Overview

AEGIS is a distributed, state-driven workflow orchestration engine that combines AI agents with reliable execution primitives.

### Core Flow

`Client/API → Orchestrator → Workflow Store → Queue → Workers → Agents → Git/Test Systems → Next Steps`

### Execution Model

#### 1. Task Intake
    
- API receives task request

#### 2. Planning

- `planner` agent generates DAG (steps + dependencies)

#### 3. Workflow Initialization

- Stored in `workflow-store`
- Steps marked as `pending`

#### 4. Scheduling

- Runnable steps pushed to queue

#### 5. Execution (Workers)

- Workers pick jobs
- Execute self-healing loop:

`run → test → fail → fix → retry`

#### 6. State Transition

- Step marked `completed` or `failed`
- Next steps unlocked dynamically

#### 7. Failure Handling

- Retries (max 3)
- Git rollback
- Dead Letter Queue (DLQ)

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
                           │        (BullMQ)          │
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
        └──────────┬───────────┘                  └──────────┬───────────┘
                   │                                         │
        ┌──────────▼──────────┐                  ┌────────────▼──────────┐
        │   Vector Memory     │                  │      Git Engine       │
        │ (semantic search)   │                  │ (checkpoint/rollback) │
        └──────────┬──────────┘                  └────────────┬──────────┘
                   │                                          │
                   ▼                                          ▼
             ┌──────────────┐                         ┌──────────────┐
             │ Test Runner  │                         │ Lock System  │
             │              │                         │  (Redlock)   │
             └──────────────┘                         └──────────────┘

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
│   │   └── decisions.log             # Decision history
│   └── settings.json                 # Agent/system setting
├── cli/                              # CLI interface
│   └── claude.js
├── engine/                           # Core system (brain)
│   ├── orchestrator.js               # Scheduler (no execution)
│   ├── agent-runner.js               # Runs AI agents
│   ├── workflow-store.js             # Workflow state engine (DAG + status)
│   ├── job-store.js                  # Job tracking (status, retries)
│   ├── queue.js                      # BullMQ queues + DLQ
│   ├── code-writer.js                # Patch parser + applier
│   ├── git.js                        # Checkpoint + rollback (git-based)
│   ├── lock.js                       # Distributed locking (Redlock)
│   ├── vector-memory.js              # RAG memory (embeddings + search)
│   ├── metrics.js                    # Metrics (success, retry, latency)
│   ├── logger.js                     # Structured logging
│   └── test-runner.js                # Test execution engine
├── workers/                          # Execution layer
│   └── agent-worker.js               # Core worker (self-healing loop)
├── scripts/                          # Automation / CI pipelines
│   └── pipeline.sh
├── server.js                         # API server + dashboard endpoints
├── package.json                      # Dependencies & scripts
├── .env                              # Environment variables
└── README.md                         # Project documentation
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

### 3. Initialize Git (REQUIRED)

```bash
git init
git add .
git commit -m "initial"
```

### 4. Start Worker

```bash
node workers/agent-worker.js
```

### 5. Start Server

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

### Resume workflow

```bash
POST /resume/:workflowId
```

---

## Current State

## ✅ What’s Solid

- Distributed execution (queue + workers)
- Self-healing loop
- Workflow engine (DAG + state)
- Git-based rollback (atomic safety)
- Distributed locking (Redlock)
- Memory system (RAG foundation)

## ⚠️ Honest Gaps

- Workflow storage uses JSON (not production-safe)
- Git strategy lacks branch isolation
- No pause/cancel controls
- Limited observability (no dashboard yet)
- No multi-tenant isolation
- Memory system is basic (needs better ranking)

## 🧭 Roadmap

# 🔜 v1.0 Production Hardening

- Database-backed workflow store (Postgres/Redis)
- Branch-based Git execution
- Workflow controls (pause / cancel)
- Observability dashboard
- Idempotency & retry policies
- Security sandboxing

## ⚠️ Reality Check

AEGIS is:

✅ Autonomous execution engine
✅ Self-healing workflow system
✅ Distributed orchestration platform

AEGIS is NOT:

❌ Fully autonomous company
❌ Zero-error system
❌ Replacement for human engineers

---

## 🤝 Contributing

This project is experimental but structured.

Areas to contribute:

- workflow engine improvements
- memory ranking (RAG)
- observability dashboard
- git execution strategies
- agent quality improvements


---

## 📜 License

MIT License

---

## 🧠 Final Note

AEGIS is not a script.

It is an early-stage autonomous execution platform.

The difference is:

`automation → orchestration → intelligence`

AEGIS is now entering the intelligence layer.
