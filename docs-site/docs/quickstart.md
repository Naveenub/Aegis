---
id: quickstart
title: Quickstart
sidebar_position: 2
---

# Quickstart

## Installation

```bash
git clone https://github.com/Naveenub/aegis.git
cd aegis
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
```

## Running

Redis Stack is required (not plain Redis) — server and worker are separate processes, and only `FT.SEARCH` gives them a shared vector index. The local-HNSW fallback is local-disk-per-process and won't see writes from the other side.

```bash
docker run -d -p 6379:6379 redis/redis-stack-server:latest

# API server
npm run server

# Agent worker (separate process)
npm run worker

# DLQ worker (separate process)
npm run dlq-worker

# CLI (submits one task and polls until done)
node cli/claude.js "add input validation to the login endpoint"
```

:::tip No Docker installed?
`sandbox.js` hard-fails by default when Docker is unavailable, so agents never run patches unsandboxed on your host by accident. For local dev without Docker, set `AEGIS_SANDBOX_MODE=local` in your `.env`. Never set this in production.
:::

## Submitting a task

```bash
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AEGIS_API_KEY_DEFAULT" \
  -d '{"task": "Add input validation to the login endpoint"}'
```

```json
{ "workflowId": "wf_...", "status": "submitted" }
```

Poll for status:

```bash
curl http://localhost:3000/workflows/wf_... \
  -H "Authorization: Bearer $AEGIS_API_KEY_DEFAULT"
```

Next: see the full [API Reference](./api-reference) or the [Configuration](./configuration) options.
