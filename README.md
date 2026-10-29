# AEGIS: Multi-Tenant AI Agent Orchestration Engine

> A Git-backed, DAG-driven pipeline that turns a task description into an executed, tested, reviewable patch — with Docker sandboxing, distributed locking, per-tenant isolation, and metered billing.

[![Version](https://img.shields.io/badge/version-v2.0.0-blue)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)]()

> **v2.0.0** — see [CHANGELOG.md](CHANGELOG.md) for release notes. Full documentation lives in [`docs-site/`](docs-site/) (Docusaurus).

---

## What AEGIS is

AEGIS is a Node.js (ESM, Node 20+) service that takes a task description, has an LLM planner decompose it into a dependency graph of steps, and executes each step through one of seven specialized agents. Each step's patch is generated, structurally validated, applied to an isolated Git worktree, linted and tested inside a Docker sandbox, and either committed or rolled back — all under Redis-backed distributed locks so multiple tenants and workflows can run concurrently without stepping on each other.

It is a REST API (`server.js`) plus a queue-backed worker pool (`workers/`), not a library you `import`. Around that core sit multi-tenant auth and quotas, a tamper-evident audit trail, Stripe-based metered billing, observability (Prometheus/OTEL, anomaly detection, two dashboards), and deployment manifests for Docker Compose, Kubernetes, and Render.

---

## Architecture

```
POST /task ──▶ orchestrator.js (runSystem)
                 │
                 ├─ planner LLM call → JSON plan → DAG validation
                 │   (cycle detection, dependency checks, agent-name checks)
                 │
                 └─ queue (BullMQ | SQS | Redis Streams) ──▶ workers/agent-worker.js
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

Every billable action ──▶ usage-recorder.js (Postgres, append-only)
                          └─▶ stripe-reporter.js (scheduled flush to Stripe)
```

Agent inputs include AST-level repo context (symbol tables, import/call graphs) from `repo-scanner.js`, and prior-fix context pulled from `vector-memory.js` (hybrid cosine + BM25 + recency search over OpenAI embeddings, when `OPENAI_API_KEY` is set — otherwise memory is a no-op and everything else still works).

### Repository layout

| Path | Contents |
|---|---|
| `server.js` | Express API server; wires routes, middleware, webhooks, anomaly detector |
| `workers/` | `agent-worker.js` (step execution) and `dlq-worker.js` (retry/escalation) |
| `engine/` | Orchestrator, agents, sandbox, git, queue, locks, memory, metrics, audit log, tenants, quotas. Smaller modules: `lock.js` (Redlock, tenant-scoped), `code-writer.js` (patch application), `lint-runner.js` / `test-runner.js` (run via the sandbox), `job-store.js` (Redis-backed job records), `queue.js` (public queue surface over the adapter) |
| `engine/adapters/` | Queue backends: `bullmq-adapter`, `sqs-adapter`, `redis-streams-adapter`, plus shared `priority-tiers` |
| `engine/billing/` | Tiers, allowance checks, signup, Stripe customer/reporter/webhook, pending-signup cleanup |
| `middleware/` | `auth.js` (API keys, tenant status gate) and `rate-limit.js` (Redis-backed) |
| `cli/claude.js` | Submit a task and poll to completion |
| `scripts/` | Billing flush/cleanup, Stripe setup, partner onboarding, DLQ inspection, prompt eval, CI pipeline |
| `.claude/` | `agents/` persona prompts (`planner`, `feature-builder`, `debugger`, …), `settings.json`, and `context/` runtime snapshots (`jobs.json`, `memory.json`, `decisions.log`) |
| `dashboard/` | React 19 + Vite operator dashboard (separate app) |
| `App.jsx`, `api/`, `components/`, `pages/` | Root-level dashboard source copies (including a `Billing` page); the maintained app is under `dashboard/src/` |
| `docs-site/` | Docusaurus documentation site |
| `monitoring/` | Prometheus alert rules and a dashboard JSON |
| `k8s/` | Kustomize manifests |
| `landing/` | Static pages served by `server.js`: `index.html` (`/`), `signup.html` (`/get-started`), `terms.html` (`/terms`), `privacy.html` (`/privacy`) |
| `tests/` | Vitest unit tests; `tests/integration/system/` for real-infrastructure tests |

---

## Core components

- **DAG-based planning** (`orchestrator.js`) — LLM produces a plan as JSON tasks with `depends_on`; the engine validates structure, rejects forward references, and detects cycles via Kahn's algorithm before anything runs.
- **Seven agent types** (`agent-runner.js`) — `feature-builder`, `debugger`, `refactorer`, `test-writer`, `security-editor`, `review-guard`, and `meta-reviewer` (fallback agent used on retry attempt 3+ by `retry-policy.js`). Personas are plain Markdown in `.claude/agents/`.
- **Retry policy** (`retry-policy.js`) — presets (`STANDARD`, `IO_BOUND`, `CODE_GEN`, `REVIEW`) with exponential backoff; attempt 2 escalates to `debugger`, attempt 3+ to `meta-reviewer`. See [`docs-site/docs/FAILURE_MODES.md`](docs-site/docs/FAILURE_MODES.md) for known gaps.
- **Workflow templates** (`template-store.js`) — freeze a validated task + plan, version it, diff versions, and re-run it without invoking the planner.
- **Docker sandbox** (`sandbox.js`) — every lint/test run for a generated patch executes inside a Docker container by default. If Docker is unavailable, it hard-fails the step *unless* `AEGIS_SANDBOX_MODE=local`, `AEGIS_SANDBOX_DISABLE=true`, or `CI=true` is set — each of those falls back to direct host execution with a loud warning. Never leave those set in production. Lint and tests run per language, detected from marker files at the worktree root: JavaScript/TypeScript (ESLint + Vitest), Python (pytest or unittest, ruff when available), Go (`gofmt` + `go vet` + `go test`) and Java (Maven or Gradle); a polyglot repo runs each. The sandbox has no network, so dependencies are installed beforehand in a separate network-enabled container (`engine/deps-cache.js`, cached per manifest hash, mounted read-only into the runs); `AEGIS_SANDBOX_AUTO_DEPS=off` disables that and `AEGIS_SANDBOX_*_DEPS` supplies caches by hand — see `.env.example`. A repo with no supported language fails lint/tests rather than passing unverified. The repo scanner that feeds agents their symbol/import/call context covers the same languages.
- **Git-based rollback** (`git.js`, `git-remote.js`) — each workflow gets its own worktree and branch; steps commit or roll back; `finaliseWorkflow()` merges and can rebase-and-retry on conflicts (`AEGIS_MERGE_STRATEGY`).
- **Step rewind** — git-revert a specific step and reset dependent steps, with a full audit trail.
- **Pluggable queue backend** (`queue-adapter.js`) — `QUEUE_BACKEND=bullmq` (default), `sqs`, or `redis-streams`. SQS and Redis Streams have no native priority, so they fan out to four queues/streams per tenant (critical/high/normal/low).
- **Concurrency control** (`concurrency.js`) — lease-based per-workflow slots by priority tier; crashed workers' slots expire via `AEGIS_CONCURRENCY_LEASE_MS`.
- **Idempotency** (`idempotency.js`) — tenant-scoped idempotency keys (default 7-day TTL) so retries don't re-apply patches.
- **Multi-tenancy** (`tenant.js`, `tenant-registry.js`, `tenant-quota.js`, `key-store.js`) — per-tenant API keys (runtime-managed in Redis, with env-var fallback), quotas, tenant status, and isolated worktrees/queues.
- **Human-in-the-loop** (`approval-gate.js`) — `CLAUDE_AUTONOMY=false` or `MODE=approval` holds every patch for review; individual steps can also set `requiresApproval`.
- **Vector memory** (`vector-memory.js`) — Redis Stack (`FT.SEARCH`) backed store with a hybrid cosine + BM25 + recency reranker, per-tenant adaptive weight feedback, and a TTL eviction cron. Requires `OPENAI_API_KEY` for embeddings; degrades gracefully to a no-op without it. On plain Redis (no Stack), `initVectorIndex()` **fails fast** with a descriptive error rather than silently desyncing across containers; set `AEGIS_ALLOW_HNSW_FALLBACK=true` only for a single-process dev setup.
- **Dead letter queue** (`workers/dlq-worker.js`) — exponential backoff retries (`DLQ_MAX_RETRIES`, `DLQ_BASE_DELAY_MS`), staleness sweeps, and webhook alerts.
- **Tamper-evident audit log** (`audit-log.js`) — per-tenant hash-chained, HMAC-signed trail of compliance-relevant actions (workflow submit/cancel, approvals, key create/revoke, merges), queryable and exportable as JSON or CSV. Set `AEGIS_AUDIT_SIGNING_KEY` in production.
- **Metered billing** (`engine/billing/`, `usage-recorder.js`) — see [Billing](#billing).
- **Observability** — Redis-backed windowed metrics with p50/p95/p99 exported as Prometheus text (`GET /metrics`) and OTEL-compatible JSON (`GET /metrics/json`); Redis-backed execution traces (`tracer.js`); an in-process anomaly detector (success rate, p95 latency, latency spikes, retry rate); Slack/Discord/generic webhook notifications (`notifier.js`).
- **Inbound webhooks** (`webhook-receiver.js`) — signature-verified GitHub/GitLab push and PR/MR webhooks can trigger workflows, filtered by branch pattern.
- **PR/MR automation** — `AEGIS_PR_PROVIDER` (`github` / `gitlab` / `bitbucket`) opens a pull/merge request after a workflow merges, targeting `AEGIS_PR_TARGET_BRANCH`.
- **AST-based repo intelligence** (`repo-scanner.js`) — built on `acorn`; produces symbol tables and import/call graphs to give agents accurate repo context.
- **Prompt eval harness** (`prompt-eval.js`, `npm run eval`) — scores each agent persona against golden cases using the real Claude API; runs as a CI gate so a bad persona edit is caught before it ships.
- **CLI** (`cli/claude.js`) — submits a task, polls `GET /workflows/:workflowId` to a terminal state, and writes a context snapshot to `.claude/context/jobs.json`.

---

## Getting Started

### Installation

```bash
git clone https://github.com/Naveenub/aegis.git
cd aegis
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
```

### Running locally

```bash
# Redis Stack is required (not plain Redis) — server and worker are separate
# processes and only FT.SEARCH gives them a shared vector index.
docker run -d -p 6379:6379 redis/redis-stack-server:latest

# Optional: Postgres, only needed for usage metering / billing.
# Without it, usage recording is best-effort and never fails a workflow.
docker run -d -p 5432:5432 -e POSTGRES_USER=aegis -e POSTGRES_PASSWORD=aegis \
  -e POSTGRES_DB=aegis postgres:16-alpine

npm run server       # API server (default port 3000)
npm run worker       # agent worker (separate process)
npm run dlq-worker   # DLQ worker (separate process)

# CLI: submit one task and poll until it finishes
node cli/claude.js "add input validation to the login endpoint"
```

> **No Docker installed?** `sandbox.js` hard-fails by default when Docker is unavailable, so agents never run patches unsandboxed on your host by accident. For local dev without Docker, set `AEGIS_SANDBOX_MODE=local` in your `.env`. Never set this in production.

### Submitting a task

```bash
curl -X POST http://localhost:3000/task \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AEGIS_API_KEY_DEFAULT" \
  -d '{"task": "Add input validation to the login endpoint"}'
```

```json
{ "workflowId": "wf_...", "status": "submitted" }
```

```bash
curl http://localhost:3000/workflows/wf_... \
  -H "Authorization: Bearer $AEGIS_API_KEY_DEFAULT"
```

---

## API Reference

Auth: `Authorization: Bearer <key>` or `x-api-key: <key>`. Keys resolve in this order: runtime keys in the Redis key-store → `AEGIS_API_KEY_{TENANTID}` env var → single-tenant `AEGIS_API_KEY` (default tenant only). Tenants whose billing status is `pending` or `suspended` receive `402` (except on billing endpoints). Write endpoints are rate-limited per tenant (`RATE_LIMIT_*`). See [`docs-site/docs/api-reference.md`](docs-site/docs/api-reference.md) for request/response details.

**Workflows**

| Method | Path | Purpose |
|---|---|---|
| POST | `/task` | Submit a task, returns `{ workflowId, status: 'submitted' }` |
| POST | `/resume` | Resume a paused workflow |
| POST | `/cancel` | Cancel a running/paused workflow |
| GET | `/workflows` | List workflows (`?status&tenantId&limit&cursor`) |
| GET | `/workflows/:workflowId` | Workflow status and step details |
| POST | `/workflows/:workflowId/steps/:stepId/rewind` | Git-revert a step, reset dependents |
| GET | `/workflows/:workflowId/rewind-history` | Rewind audit trail |
| GET | `/concurrency/:workflowId` | Current concurrency slot usage |

**Templates**

| Method | Path | Purpose |
|---|---|---|
| POST | `/templates` | Save a task + plan as a reusable template |
| GET | `/templates/:id` | Fetch a template |
| POST | `/templates/:id/run` | Run a template (skips the planner) |
| GET | `/templates/:id/versions` | List prior versions |
| GET | `/templates/:id/diff` | Diff two template versions |

**Jobs, review, and failures**

| Method | Path | Purpose |
|---|---|---|
| GET | `/jobs`, `/jobs/:jobId` | Persisted job records |
| GET | `/dlq` | Dead-letter entries (tenant-scoped) |
| GET | `/review-queue` | Steps held for human approval |
| POST | `/review-queue/resolve` | Approve, reject, or otherwise resolve a held step |
| GET | `/traces`, `/traces/:traceId` | Workflow execution traces |

**Observability**

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness probe, no auth |
| GET | `/`, `/get-started`, `/terms`, `/privacy` | Landing, signup, terms, and privacy pages, no auth |
| GET | `/metrics` | Prometheus text-format export |
| GET | `/metrics/json` | OTEL-compatible JSON export |
| GET | `/api/metrics` | Structured metrics (used by dashboards) |
| GET | `/anomalies` | Recent anomaly alerts |
| GET | `/dashboard` | Built-in single-file HTML dashboard |
| GET | `/events` | Live SSE stream (metrics + workflows, every 4 s) |

**Tenants, keys, audit, billing**

| Method | Path | Purpose |
|---|---|---|
| GET | `/signup/config` | Unauthenticated; Stripe publishable key and self-serve tiers for the signup page |
| POST | `/signup` | Unauthenticated self-serve signup (Stripe customer + subscription, tenant, first API key) |
| POST | `/billing/portal` | Stripe billing-portal URL |
| GET/POST | `/tenants`, `/tenants/:id` | Tenant management |
| GET | `/tenants/:id/billing` | Tier + usage vs. included allowance |
| GET/POST/DELETE | `/tenants/:id/keys[/:keyId]` | Per-tenant API key management (key is returned once on creation) |
| GET | `/tenants/:id/audit-log` | Query the compliance audit trail |
| GET | `/tenants/:id/audit-log/export` | Export the audit trail (JSON or CSV) |
| GET | `/auth/sso/:tenantId/login` | Start OIDC single sign-on |
| GET | `/auth/me` | Who am I: identity, role, permissions (API key or session) |
| POST | `/auth/logout` | End an SSO session |
| GET / POST | `/tenants/:id/users` | List / pre-provision users (admin) |
| PATCH | `/tenants/:id/users/:userId` | Change a user's role or disable them (admin) |
| GET / PUT / DELETE | `/tenants/:id/sso` | SSO config (read: admin; write: operator `x-admin-key`) |

**Inbound webhooks** (authenticated by signature, not API key)

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhooks/github` | GitHub push / pull_request events |
| POST | `/webhooks/gitlab` | GitLab push / merge-request events |
| POST | `/webhooks/stripe` | Stripe events that drive tenant status |

---

## Access control & SSO

**Roles.** Every credential has one: `viewer` (read-only), `member` (+ run, cancel, resume, rewind workflows; resolve reviews), `admin` (+ API keys, users, audit log, BYOK, billing actions). The permission table is `engine/rbac.js`. API keys get a role at creation (`POST /tenants/:id/keys {"role":"member"}`, default `member`); keys from before roles existed and env-var keys are `admin`.

**SSO (OIDC).** Set `AEGIS_PUBLIC_URL`, `AEGIS_TOKEN_ENCRYPTION_KEY`, `AEGIS_ADMIN_KEY` and (for the React dashboard) `AEGIS_DASHBOARD_URL`. Register `<AEGIS_PUBLIC_URL>/auth/sso/callback` as the redirect URI at your IdP, then, as the operator:

```bash
curl -X PUT $AEGIS/tenants/acme/sso -H "x-admin-key: $AEGIS_ADMIN_KEY" -H 'content-type: application/json' -d '{
  "issuer": "https://acme.okta.com", "clientId": "…", "clientSecret": "…",
  "allowedDomains": ["acme.com"], "jitRole": "viewer"
}'
```

Pre-provision admins with `POST /tenants/acme/users {"email":"jo@acme.com","role":"admin"}`; anyone else from an allowed domain is created at `jitRole` (never `admin`; omit `jitRole` to allow only pre-provisioned users). The first login binds the IdP `sub` to the user. Sessions last `AEGIS_SESSION_TTL_HOURS` (default 8); disabling a user or changing their role applies immediately. SAML is not supported.

**Audit identity.** Audit events record `actorType` (`user` / `api-key`), `actorId`, `actorEmail`, `actorRole` and `ip`; logins, logouts, denied logins, user changes and SSO changes are audited, and API keys record who created them.

## Billing

Billing is optional. A deployment without Stripe or Postgres still runs; usage simply isn't metered.

- **Tiers** (`engine/billing/tiers.js`) — `free`, `starter` (default for existing tenants), `pro`, and `enterprise`. Each defines hard quota ceilings (`maxActiveWorkflows`, `maxDailyWorkflows`, `maxQueuedJobs`) and an included monthly allowance for five metered dimensions: workflow runs, agent steps, input tokens, output tokens, and sandbox minutes. Input and output tokens are separate meters because output costs 5x input ($3/M vs $15/M for Claude Sonnet); one summed meter would let output-heavy tenants run at negative margin. Enterprise allowances are unlimited.
- **Metering** — every billable action is appended to an immutable `usage_events` table in Postgres (`DATABASE_URL`). This is separate from `tenant-quota.js`, which only holds live rate-limit counters in Redis.
- **Reporting** — `npm run billing:flush` pushes unreported usage to Stripe's metered billing API. Run it on a schedule (hourly cron, the k8s CronJob, or the Render cron in `render.yaml`). Without `STRIPE_SECRET_KEY` it fails closed and usage keeps accumulating.
- **Signup page** — `/get-started` is a built-in page that calls `POST /signup` and confirms the first payment with Stripe.js. Set `STRIPE_PUBLISHABLE_KEY`; the landing page's pricing buttons link to it.
- **Signup** — `POST /signup` creates a Stripe customer and subscription, registers the tenant as `pending`, and issues a first API key. The key is unusable (`402`) until the first payment succeeds and Stripe's `invoice.paid` webhook flips the tenant to `active`.
- **Tenant status** — `POST /webhooks/stripe` (signature-verified with `STRIPE_WEBHOOK_SECRET`) sets tenants `active` on `invoice.paid`, and `suspended` on `invoice.payment_failed` or subscription deletion/past-due. Subscribe the endpoint to `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, and `customer.subscription.updated`.
- **Cleanup** — `npm run billing:cleanup` removes (or reconciles) self-serve signups that never paid; defaults to tenants pending longer than 48 h, supports `--hours=N` and `--dry-run`.
- **One-time Stripe setup** — `node scripts/stripe-setup.js` creates the Billing Meters and prices and prints the `STRIPE_PRICE_*` env lines. Use a test-mode key first; it is not idempotent.
- **Design partners** — `npm run onboard -- <tenantId> [label] [tier]` registers a tenant and issues a key directly, with no running server or Stripe involved.

See [`docs-site/docs/billing.md`](docs-site/docs/billing.md) for details.

---

## Dashboards

- **Built-in** — `GET /dashboard` serves a self-contained HTML page (`engine/dashboard.html`) fed by the `/events` SSE stream. No build step.
- **React dashboard** (`dashboard/`) — a separate React 19 + Vite app with pages for Login, Overview, Workflows (and workflow detail), Review Queue, DLQ, Traces, Anomalies, and Tenants. Sign in with an API key. It is not served by `server.js`:

  ```bash
  cd dashboard
  npm install
  npm run dev          # set VITE_AEGIS_API_URL to your API base URL
  npm run build
  ```

- **Prometheus / Grafana** — scrape `/metrics`; alert rules are in `monitoring/aegis-alerts.yml` and a dashboard in `monitoring/aegis-dashboard.json`.

---

## Configuration

Configuration is environment-variable driven — see `.env.example` for the full, documented list and [`docs-site/docs/configuration.md`](docs-site/docs/configuration.md). Highlights:

```bash
ANTHROPIC_API_KEY=...          # required — all agent LLM calls
OPENAI_API_KEY=...             # optional — enables vector memory embeddings
REDIS_URL=redis://...          # Redis Stack
DATABASE_URL=postgres://...    # optional — usage metering / billing
AEGIS_API_KEY_DEFAULT=...      # per-tenant API key(s)
AEGIS_TENANTS=default          # tenants registered at boot
PORT=3000
QUEUE_BACKEND=bullmq           # or sqs | redis-streams
CLAUDE_AUTONOMY=true           # false = every patch held for human review
AEGIS_SANDBOX_MODE=            # 'local' bypasses Docker (dev only, never prod)
AEGIS_MERGE_STRATEGY=rebase    # or 'flag'
AEGIS_AUDIT_SIGNING_KEY=...    # required in production
DLQ_MAX_RETRIES=2
STRIPE_SECRET_KEY=...          # optional — billing
STRIPE_WEBHOOK_SECRET=...      # optional — billing
```

Vector memory reranking, concurrency limits per priority tier, rate limits, DLQ backoff, anomaly thresholds, PR automation, Slack/Discord webhooks, and inbound webhook secrets are all separately tunable.

> **Security note:** never commit real secrets. Keep `.env` out of version control (it is already in `.dockerignore`), and generate your own values for `AEGIS_API_KEY_*` and `AEGIS_AUDIT_SIGNING_KEY` (the commands are in `.env.example`).

---

## Testing

```bash
npm test               # unit tests (vitest --project unit)
npm run test:system    # system tests against real Redis/git/Docker
npm run test:all       # everything
npm run test:coverage  # unit tests with coverage (80% lines/functions, 70% branches)
npm run lint           # eslint
npm run eval           # agent prompt eval (needs ANTHROPIC_API_KEY)
npm run check          # lint + coverage
```

The unit suite (`tests/`) covers agent-runner, approval-gate, audit-log (incl. identity), auth/billing gate, RBAC, SSO and sessions, billing tiers and allowance, concurrency, the git engine, the pipeline, prompt-eval (including adversarial cases), repo-scanner, retry-policy, review-system, signup, Stripe reporter/webhook, pending-cleanup, usage-recorder, vector-memory, and workflow-store.

The system suite (`tests/integration/system/`) exercises the Docker sandbox, git worktrees, the end-to-end pipeline, and the BullMQ/Redis Streams/SQS queue backends against real infrastructure. These need a live Docker daemon and Redis (Redis Stack for FT.SEARCH-backed vector memory); the Docker sandbox tests skip themselves when Docker isn't reachable.

**CI** (`.github/workflows/ci.yml`) runs lint + unit tests with coverage, then system tests, then the prompt eval gate. The eval step is skipped on fork PRs without secrets and is non-blocking if the Claude API is unreachable.

---

## Deployment

### One-click (trial / eval)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Naveenub/aegis)

`render.yaml` provisions Postgres, a Redis Stack private service, a single combined web service (server + worker + dlq-worker sharing one disk), and an hourly billing-flush cron. You'll be prompted for `ANTHROPIC_API_KEY` during setup. Tenant code never runs on the web service: set `DOCKER_HOST` (mutual TLS), the `ca.pem`/`cert.pem`/`key.pem` Secret Files and `AEGIS_SANDBOX_IMAGE` (built from `Dockerfile.sandbox`) to point it at an isolated remote runner (see `scripts/provision-runner.sh`); without them lint/test steps are blocked and self-serve signup stays off. The worktree is streamed to the runner as a tar (no host paths, no `.git`), so only stdout comes back. This topology trades away horizontal worker scaling in exchange for a deploy with no nested Docker. Fork the repo first if you're deploying your own copy.

### Self-hosted with Docker Compose (production)

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
docker compose up -d --build
```

This starts `redis` (Redis Stack), `postgres`, `server` (port 3000), `worker`, `dlq-worker`, and a rootless `dind` sidecar, all from a single `node:20-alpine` image (`Dockerfile`). Two things worth knowing:

- **`worker` talks to a rootless Docker-in-Docker sidecar (`dind`), not the host socket.** `sandbox.js` shells out to `docker run` for every lint/test execution; pointing `DOCKER_HOST` at the isolated rootless daemon instead of mounting `/var/run/docker.sock` caps a sandbox compromise at that sidecar's unprivileged UID rather than the host. For a genuinely multi-tenant deployment, the next step up is a dedicated remote Docker host.
- **`server` and `worker` share a `repo` volume** so `AEGIS_REPO_ROOT`/`AEGIS_WORKTREES` resolve to the same git checkout across both processes.

### Kubernetes

Manifests under `k8s/` cover the namespace, configmap, Redis Stack, repo PVC, server/worker/dlq-worker deployments, HPA, ingress, and two CronJobs (billing flush and pending-signup cleanup). Apply with `kubectl apply -k k8s/`. Read `k8s/README.md` first — it covers the `ReadWriteMany` storage requirement, the privileged `dind` sidecar, and the single-replica server constraint.

See [`docs-site/docs/deployment.md`](docs-site/docs/deployment.md) for more.

---

## Documentation

The Docusaurus site in `docs-site/` covers the intro, quickstart, architecture, configuration, API reference, billing, deployment, testing, and a candid [failure-modes](docs-site/docs/FAILURE_MODES.md) register. Run it locally with:

```bash
cd docs-site && npm install && npm start
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Contact

- **GitHub Issues:** Bug reports and feature requests
- **Email:** badigernaveen2@gmail.com

Made by Naveen Badiger | [GitHub](https://github.com/Naveenub)
