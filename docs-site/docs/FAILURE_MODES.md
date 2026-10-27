# AEGIS Failure Modes

Failure modes found by reading the retry, DLQ, lock, idempotency, sandbox and
eval-gate code paths. Each row says what happens today, not what is intended.
Status: **Fixed** (in this change), **Open** (known, not yet addressed), or
**By design** (documented trade-off).

## 1. Retry and escalation (`engine/retry-policy.js`)

Attempt 1 runs the step's own agent, attempt 2 the `escalationAgent`
(`debugger` by default), attempt 3+ the `fallbackAgent` (`meta-reviewer`).
Presets: `STANDARD` 3 attempts, exponential from 2 s capped at 60 s;
`IO_BOUND` 5 attempts from 3 s; `CODE_GEN` 2 attempts, immediate;
`REVIEW` 1 attempt, no escalation (hard block).

| # | Failure mode | Behavior today | Status |
|---|---|---|---|
| R1 | No jitter in backoff | `calcDelay` is deterministic, so workers that hit the same rate limit retry in lockstep | Open |
| R2 | Unknown preset name fails open | A typo (e.g. `retryPolicy: "REVEIW"`) logs a warning and falls back to `STANDARD`: a hard-block review step silently becomes a 3-attempt retry | Open |
| R3 | Inline policy not validated | `retryPolicy: {...}` is merged over defaults with no type or range check (`maxAttempts: 0`, strings, negatives pass through) | Open |

## 2. Dead-letter queue (`workers/dlq-worker.js`)

Failed steps land in a per-tenant DLQ. The worker re-queues each into the
CRITICAL lane up to `DLQ_MAX_RETRIES` (default 2) with exponential backoff from
`DLQ_BASE_DELAY_MS` (default 30 s, capped at 5 min), then writes a
`needs-review` record. A sweep every 15 min re-alerts on unresolved items.
Humans resolve via `POST /review-queue/resolve` (`retrying`, `skip`, `escalate`).

| # | Failure mode | Behavior today | Status |
|---|---|---|---|
| D1 | Retry budget exhausted | Step moves to human review; workflow waits until someone resolves it | By design |
| D2 | Unattended review items | Re-alerted every 15 min by the staleness sweep; no automatic expiry or escalation | By design |
| D3 | `skip` leaves downstream steps running | Marking a step skipped lets the workflow continue on a step that never produced output | Open |

## 3. Locks and idempotency (`engine/lock.js`, `engine/idempotency.js`)

| # | Failure mode | Behavior today | Status |
|---|---|---|---|
| L1 | Lock expires mid-step | Redlock TTL is 10 s and I found no extension or renewal in `lock.js`; a step that runs longer can lose its lock while still executing | Open |
| L2 | Release after expiry | `releaseLock` swallows the "already released / expired" error, so lock loss is silent | By design |
| I1 | Ambiguous operation ID | `sha256(workflowId + stepId + patch)` concatenates without a delimiter, so `("ab","c")` and `("a","bc")` hash identically | Open |
| I2 | Key expiry re-opens replay | Idempotency keys expire after 7 days (`AEGIS_IDEM_TTL_SECONDS`); a replay after that re-applies the patch | By design |
| I3 | Check-then-set | `isApplied` and `markApplied` are separate Redis calls; exactly-once relies on the surrounding lock (see L1) | Open |

## 4. Sandbox (`engine/sandbox.js`)

Lint/test runs in Docker: 512 MB RAM, 1 CPU, 60 s wall clock (`AEGIS_SANDBOX_TIMEOUT_MS`).

| # | Failure mode | Behavior today | Status |
|---|---|---|---|
| S1 | Docker unavailable | Step hard-fails | By design |
| S2 | Escape hatches | `AEGIS_SANDBOX_MODE=local`, `AEGIS_SANDBOX_DISABLE=true` or `CI=true` run generated code unsandboxed on the host; harmless in CI, unsafe if left set in production | By design (documented in README) |
| S3 | Remote runner down | When `DOCKER_HOST` is set, the S2 escape hatches are ignored: an unreachable runner blocks the step and never falls back to the host | By design |

## 5. Vector memory (`engine/vector-memory.js`)

| # | Failure mode | Behavior today | Status |
|---|---|---|---|
| V1 | No `OPENAI_API_KEY` | Memory degrades to a no-op; retrieval silently returns nothing | By design |
| V2 | HNSW fallback | Single-process only, so server and worker containers see different memory; startup fails fast unless `AEGIS_ALLOW_HNSW_FALLBACK=true` | By design |

## 6. Eval gate (`engine/prompt-eval.js`, `scripts/run-prompt-eval.js`)

The CI `prompt-eval` job gates on a pass rate (80% of cases, 6/8 per case).

| # | Failure mode | Behavior today | Status |
|---|---|---|---|
| E1 | Scorer crashed on non-string output | `scoreResponse(agent, undefined)` threw `TypeError` | Fixed |
| E2 | Greedy PATCH regex | Valid patch followed by prose containing `}` was parsed as invalid JSON (false failure) | Fixed |
| E3 | Unusable patch could pass | A patch with a non-string `file` still scored 7/8 on reasoning points | Fixed |
| E4 | Plan with unknown agent could pass | Scored 7/8 despite referencing agents outside the roster | Fixed |
| E5 | Gate skipped on fork PRs | Without `ANTHROPIC_API_KEY` the job warns and skips instead of failing | By design |

Regression tests for E1-E4 and 14 further hostile-input cases:
`tests/prompt-eval-adversarial.test.js`.
