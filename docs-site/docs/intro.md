---
id: intro
title: What AEGIS Actually Is
sidebar_position: 1
slug: /
---

# What AEGIS actually is

AEGIS is a Node.js (ESM, Node 20+) service that takes a task description, has an LLM planner decompose it into a dependency graph of steps, and executes each step through one of seven specialized agents. Each step's patch is generated, structurally validated, applied to an isolated Git worktree, linted and tested inside a Docker sandbox, and either committed or rolled back — all under Redis-backed distributed locks so multiple tenants and workflows can run concurrently without stepping on each other.

It is a REST API (`server.js`) plus a BullMQ worker pool (`workers/`), not a library you `import` and call `new AEGIS()` on.

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

Continue to [Quickstart](./quickstart) to get a workflow running, or jump to [Architecture](./architecture) for the full component breakdown.
