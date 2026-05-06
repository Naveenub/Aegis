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

1. Autonomous Execution
Multi-agent system (planner, debugger, reviewer)
Task decomposition into executable steps
Agent-driven patch generation
2. Self-Healing System
run → test → fail → fix → retry (max 3)
Automatic debugging
Error-aware retries
Continuous improvement loop
3. Workflow Engine (DAG)
Step dependency tracking (dependsOn)
State transitions:
pending → running → completed / failed
Dynamic scheduling of next steps
Resumable workflows
4. Distributed Architecture
Queue-based execution (BullMQ)
Worker-based processing
Horizontal scaling ready
5. Transaction Safety (Git-Based)
checkpoint → apply → test → rollback (if fail)
Atomic rollback using Git
Full repository state recovery
Multi-file consistency
6. Distributed Locking
Redis-based Redlock
Prevents race conditions
Safe multi-worker execution
7. Memory System (RAG)
Stores past fixes
Retrieves similar issues
Improves agent decisions over time
8. Observability (Basic)
Success / failure tracking
Retry metrics
Structured logging hooks
---

## 🧱 Architecture Overview

Aegis operates in the following flow:

```
Task  
↓  
Planner  
↓  
Agents (parallel / sequential)  
↓  
Review Guard  
↓  
Patch Apply  
↓  
Test Gate  
↓  
Commit  
↓  
Learning (memory)
```

---

## 🧠 ASCII Architecture

```
                    ┌──────────────────────┐
                    │        USER          │
                    │  CLI / API / Script  │
                    └──────────┬───────────┘
                               ↓
                    ┌──────────────────────┐
                    │     ORCHESTRATOR     │
                    │   (Task Controller)  │
                    └──────────┬───────────┘
                               ↓
                    ┌──────────────────────┐
                    │        PLANNER       │
                    │    (Task Breakdown)  │
                    └──────────┬───────────┘
                               ↓
        ┌───────────────────────────────────────────┐
        │              AGENT LAYER                  │
        │                                           │
        │    debugger | refactorer | test-writer    │
        │     feature-builder | security-editor     │
        └───────────────────────────────────────────┘
                               ↓
                    ┌──────────────────────┐
                    │     REVIEW GUARD     │
                    │    (Approval Gate)   │
                    └──────────┬───────────┘
                               ↓
                    ┌────────────────────────┐
                    │   CODE WRITER          │
                    │ (Patch Apply + Backup) │
                    └──────────┬─────────────┘
                               ↓
                    ┌──────────────────────┐
                    │    TEST / VERIFY     │
                    │ (Optional pipeline)  │
                    └──────────┬───────────┘
                               ↓
                    ┌──────────────────────┐
                    │          GIT         │
                    │   (Commit Changes)   │
                    └──────────┬───────────┘
                               ↓
        ┌───────────────────────────────────────────┐
        │         MEMORY + OBSERVABILITY            │
        │                                           │
        │    memory.json | decisions.log | logger   │
        └───────────────────────────────────────────┘
                               ↓
                    ┌──────────────────────┐
                    │    META-REVIEWER     │
                    │  (Self Improvement)  │
                    └──────────────────────┘     
```

---

## 📁 Project Structure

```
aegis/
├── .claude/                         # AI system brain (agents + rules + memory)
│   ├── agents/                      # All AI agents (modular roles)
│   │   ├── planner.md               # Breaks tasks into steps
│   │   ├── debugger.md              # Finds & fixes bugs
│   │   ├── refactorer.md            # Improves code quality
│   │   ├── test-writer.md           # Generates tests
│   │   ├── review-guard.md          # Safety + approval gate
│   │   ├── security-editor.md       # Security validation
│   │   ├── feature-builder.md       # Builds new features
│   │   └── meta-reviewer.md         # Learns & improves system
│   ├── context/                     # Persistent system memory
│   │   ├── memory.json              # Long-term learnings (RAG-lite)
│   │   └── decisions.log            # Execution logs / audit trail
│   └── settings.json                # System config (modes, guardrails)
├── cli/                             # Command line interface
│   └── claude.js                    # Entry point (runs Aegis tasks)
├── engine/                          # Core execution engine
│   ├── orchestrator.js              # Main controller (runs pipeline)
│   ├── agent-runner.js              # Calls Claude API per agent
│   ├── repo-scanner.js              # Reads codebase context
│   ├── code-writer.js               # Applies patches safely
│   ├── memory.js                    # Stores learnings
│   ├── queue.js                     # Task queue (scalability)
│   ├── logger.js                    # Logging (observability)
│   └── git.js                       # Git automation (commit changes)
├── workers/                         # Background processing (scalable)
│   └── agent-worker.js              # Executes agents via queue
├── scripts/                         # Automation scripts
│   └── pipeline.sh                  # CI-like local pipeline
├── server.js                        # API server (external access)
├── package.json                     # Dependencies + scripts
├── .env                             # Secrets / API keys
└── README.md                        # Documentation
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
