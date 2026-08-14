---
id: testing
title: Testing
sidebar_position: 7
---

# Testing

```bash
npm test          # unit tests (vitest --project unit)
npm run test:system   # system/integration tests
npm run test:all      # everything
npm run test:coverage # with coverage
```

11 test files under `tests/` covering agent-runner, approval-gate, concurrency, the git engine, the pipeline, prompt-eval, repo-scanner, retry-policy, review-system, vector-memory, and workflow-store.

:::note Known gap
`npm run test:system` (`tests/integration/system/`) requires a live Docker daemon and Redis Stack (`FT.SEARCH`). It does not run in sandboxed/CI environments without those — `docker-sandbox`, `git-worktree`, `e2e-pipeline`, and the queue backends (`redis-queue`, `redis-streams-queue`, `sqs-queue`) are exercised only where those services are actually available. `npm test` (unit) has no such dependency.
:::
