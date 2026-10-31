# AEGIS: Multi-Tenant AI Agent Orchestration Engine

> A Git-backed, DAG-driven pipeline that turns a task description (or a labeled GitHub issue) into an executed, tested, reviewable patch — with Docker sandboxing, distributed locking, per-tenant isolation, hard LLM spend control, and metered billing.

[![Version](https://img.shields.io/badge/version-v2.0.0-blue)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)]()

> **v2.0.0** plus the changes under *Unreleased* in [CHANGELOG.md](CHANGELOG.md). Full documentation lives in [`docs-site/`](docs-site/) (Docusaurus).

---

## What AEGIS is

AEGIS is a Node.js (ESM, Node 20+) service that takes a task description, has an LLM planner decompose it into a dependency graph of steps, and executes each step through one of seven specialized agents. Each step's patch is generated, structurally validated, applied to an isolated Git worktree, linted and tested inside a Docker sandbox, and either committed or rolled back — all under Redis-backed distributed locks so multiple tenants and workflows can run concurrently without stepping on each other.

It is a REST API (`server.js`) plus a queue-backed worker pool (`workers/`), not a library you `import`. Around that core sit multi-tenant auth (API keys, RBAC, OIDC SSO), per-tenant repository connections, issue-label triggers, hard per-tenant spend caps with prepaid credits and BYOK, a tamper-evident audit trail, Stripe-based metered billing, a compliance pack (retention, DPA, subprocessors), observability (Prometheus/OTEL, anomaly detection, two dashboards), and deployment manifests for Docker Compose, Kubernetes, and Render.

---

## Architecture

```
POST /task ───────────┐
GitHub issue label ───┤ (GitHub App webhook → /webhooks/github-app)
push / PR webhooks ───┤
POST /templates/:id/run
                      ▼
              orchestrator.js (runSystem)
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
                                       │   (spend-guard.js reserves cost before each
                                       │    platform-key call; prompt-guard.js wraps
                                       │    untrusted repo content)
                                       │
                                       ├─ review-system.js: structural patch
                                       │   validation, pre-flight checks
                                       │
                                       ├─ sandbox.js + toolchains.js: Docker-isolated
                                       │   lint + test run, per language
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

Agent inputs include AST-level repo context (symbol tables, import/call graphs) from `repo-scanner.js` (JavaScript/TypeScript, Python, Go and Java analyzers in `engine/analyzers/`), and prior-fix context pulled from `vector-memory.js` (hybrid cosine + BM25 + recency search over OpenAI embeddings, when `OPENAI_API_KEY` is set — otherwise memory is a no-op and everything else still works).

### Repository layout

| Path | Contents |
|---|---|
| `server.js` | Express API server; wires routes, middleware, webhooks, retention scheduler, anomaly detector |
| `workers/` | `agent-worker.js` (step execution) and `dlq-worker.js` (retry/escalation) |
| `engine/` | Orchestrator, agents, sandbox, git, queue, locks, memory, metrics, audit log, tenants, quotas, RBAC/SSO, retention. Notable modules: `lock.js` (Redlock, tenant-scoped), `code-writer.js` (patch application), `lint-runner.js` / `test-runner.js` / `toolchains.js` / `deps-cache.js` (per-language lint/test via the sandbox), `prompt-guard.js` (prompt-injection defences), `job-store.js`, `workflow-store.js`, `queue.js` |
| `engine/adapters/` | Queue backends: `bullmq-adapter`, `sqs-adapter`, `redis-streams-adapter`, plus shared `priority-tiers` |
| `engine/analyzers/` | Language analyzers for the repo scanner: `python`, `go`, `java`, shared `common` |
| `engine/billing/` | Tiers, allowance, free tier, spend guard, credits, BYOK, signup, plan change, tax, Stripe customer/reporter/webhook, pending-signup cleanup, pricing model |
| `engine/providers/` | GitLab and Bitbucket OAuth/PR providers (GitHub via `github-app.js`) |
| `engine/auth-routes.js`, `sso.js`, `rbac.js`, `user-store.js` | OIDC SSO, sessions, roles, user admin |
| `engine/repo-routes.js`, `tenant-repo.js`, `repo-store.js`, `token-vault.js` | Per-tenant repo connection (GitHub App, GitLab/Bitbucket OAuth), encrypted token storage |
| `engine/trigger-routes.js`, `inbound-triggers.js`, `trigger-store.js` | Slack and Jira triggers (see [Triggers](#inbound-triggers)) |
| `engine/retention*.js`, `compliance-pages.js`, `workflow-purge.js` | Retention policy, scheduler, sweeps, data deletion, DPA/subprocessor pages |
| `middleware/` | `auth.js` (API keys, tenant status gate) and `rate-limit.js` (Redis-backed) |
| `cli/claude.js` | Submit a task and poll to completion |
| `scripts/` | Billing flush/cleanup/migrations, Stripe setup, cost measurement and pricing proposal, partner onboarding, DLQ inspection, prompt eval, retention sweep, compliance check, trigger smoke test, runner provisioning, CI pipeline |
| `bench/` | ROI benchmark harness and 8 verified tasks (see [Evidence](#evidence-does-it-pay-for-itself)) |
| `compliance/` | `subprocessors.json` and `launch-signoff.json`, checked by `npm run compliance:check` |
| `deploy/` | GitHub App manifest and Slack app manifest |
| `marketplace/` | GitHub Marketplace listing copy |
| `sandbox/`, `Dockerfile.sandbox` | Sandbox images (Python image with pytest + ruff; base sandbox image) |
| `.claude/` | `agents/` persona prompts (`planner`, `feature-builder`, `debugger`, …), `settings.json`, and `context/` runtime snapshots (`jobs.json`, `memory.json`, `decisions.log`) |
| `dashboard/` | React 19 + Vite operator dashboard (separate app) |
| `docs-site/` | Docusaurus documentation site |
| `monitoring/` | Prometheus alert rules and a dashboard JSON |
| `k8s/` | Kustomize manifests |
| `landing/` | Static pages served by `server.js`: `index.html` (`/`), `signup.html` (`/get-started`), `terms.html`, `privacy.html`, `dpa.html`, `security.html`, `subprocessors.html` |
| `tests/` | Vitest unit tests; `tests/integration/system/` for real-infrastructure tests |

---

## Core components

- **DAG-based planning** (`orchestrator.js`) — LLM produces a plan as JSON tasks with `depends_on`; the engine validates structure, rejects forward references, and detects cycles via Kahn's algorithm before anything runs.
- **Seven agent types** (`agent-runner.js`) — `feature-builder`, `debugger`, `refactorer`, `test-writer`, `security-editor`, `review-guard`, and `meta-reviewer` (fallback agent used on retry attempt 3+ by `retry-policy.js`). Personas are plain Markdown in `.claude/agents/`.
- **Model routing** (`agent-runner.js`) — `planner` and `review-guard` use a cheap model (`AEGIS_MODEL_CHEAP`, default Haiku 4.5); every other agent uses a build model (`AEGIS_MODEL_BUILD`, default Sonnet 4). `AEGIS_MODEL` pins both tiers. When a build-tier call hits the tenant's spend cap, it is re-reserved once on the cheap model and flagged `capFallback` (`AEGIS_CAP_FALLBACK=0` refuses instead). Inactive-tenant and guard-unavailable errors never fall back, and BYOK never downgrades.
- **Retry policy** (`retry-policy.js`) — presets (`STANDARD`, `IO_BOUND`, `CODE_GEN`, `REVIEW`) with exponential backoff; attempt 2 escalates to `debugger`, attempt 3+ to `meta-reviewer`. See [`docs-site/docs/FAILURE_MODES.md`](docs-site/docs/FAILURE_MODES.md) for known gaps.
- **Workflow templates** (`template-store.js`) — freeze a validated task + plan, version it, diff versions, and re-run it without invoking the planner.
- **Docker sandbox** (`sandbox.js`) — every lint/test run for a generated patch executes inside a Docker container by default. If Docker is unavailable, it hard-fails the step *unless* `AEGIS_SANDBOX_MODE=local`, `AEGIS_SANDBOX_DISABLE=true`, or `CI=true` is set — each of those falls back to direct host execution with a loud warning. Never leave those set in production. With `DOCKER_HOST` set (remote runner), those overrides are ignored and a **stream transport** is used: the worktree (minus `.git`) is sent as a tar on stdin into uid-65534 tmpfs mounts, nothing is bind-mounted, and container writes never reach the host (`AEGIS_SANDBOX_TRANSPORT`, `AEGIS_SANDBOX_STREAM_MAX_MB`, `AEGIS_SANDBOX_WORKTREE_TMPFS_MB`). Lint and tests run per language, detected from marker files at the worktree root: JavaScript/TypeScript (ESLint + Vitest), Python (pytest or unittest, ruff when available), Go (`gofmt` + `go vet` + `go test`) and Java (Maven or Gradle); a polyglot repo runs each. The sandbox has no network, so dependencies are installed beforehand in a separate network-enabled container (`engine/deps-cache.js`, cached per manifest hash, mounted read-only into the runs); `AEGIS_SANDBOX_AUTO_DEPS=off` disables that and `AEGIS_SANDBOX_*_DEPS` supplies caches by hand — see `.env.example`. A repo with no supported language fails lint/tests rather than passing unverified.
- **Prompt-injection defences** (`prompt-guard.js`) — repo files, symbol names, test/lint output, memory and prior patch attempts are treated as data: nonce-delimited isolation, stripping of invisible/bidi characters, and detection. High-severity detections block the call (`AEGIS_INJECTION_MODE=block`, default; `flag` only logs).
- **Git-based rollback** (`git.js`, `git-remote.js`) — each workflow gets its own worktree and branch; steps commit or roll back; `finaliseWorkflow()` merges and can rebase-and-retry on conflicts (`AEGIS_MERGE_STRATEGY`). The per-tenant base branch (`aegis-tenant/<id>`) is kept in sync with the default branch (`AEGIS_BASE_SYNC=off` disables).
- **Step rewind** — git-revert a specific step and reset dependent steps, with a full audit trail.
- **Per-tenant repositories** (`tenant-repo.js`, `repo-routes.js`) — with `AEGIS_REPOS_BASE` set (the default in shipped deploy configs), each tenant connects its own repo: GitHub via a GitHub App (short-lived installation tokens), GitLab and Bitbucket Cloud via OAuth 2.0 (tokens AES-256-GCM encrypted with `AEGIS_TOKEN_ENCRYPTION_KEY`, refreshed on demand). In this mode the global `AEGIS_REPO_ROOT` / `AEGIS_PR_*` settings are ignored.
- **Pluggable queue backend** (`queue-adapter.js`) — `QUEUE_BACKEND=bullmq` (default), `sqs`, or `redis-streams`. SQS and Redis Streams have no native priority, so they fan out to four queues/streams per tenant (critical/high/normal/low).
- **Concurrency control** (`concurrency.js`) — lease-based per-workflow slots by priority tier; crashed workers' slots expire via `AEGIS_CONCURRENCY_LEASE_MS`.
- **Idempotency** (`idempotency.js`) — tenant-scoped idempotency keys (default 7-day TTL) so retries don't re-apply patches.
- **Multi-tenancy** (`tenant.js`, `tenant-registry.js`, `tenant-quota.js`, `key-store.js`) — per-tenant API keys (runtime-managed in Redis, with env-var fallback), quotas, tenant status, and isolated worktrees/queues.
- **Access control and SSO** (`rbac.js`, `sso.js`) — see [Access control & SSO](#access-control--sso).
- **Human-in-the-loop** (`approval-gate.js`) — `CLAUDE_AUTONOMY=false` or `MODE=approval` holds every patch for review; individual steps can also set `requiresApproval`.
- **Vector memory** (`vector-memory.js`) — Redis Stack (`FT.SEARCH`) backed store with a hybrid cosine + BM25 + recency reranker, per-tenant adaptive weight feedback, and a TTL eviction cron. Requires `OPENAI_API_KEY` for embeddings; degrades gracefully to a no-op without it. On plain Redis (no Stack), `initVectorIndex()` **fails fast** with a descriptive error; set `AEGIS_ALLOW_HNSW_FALLBACK=true` only for a single-process dev setup.
- **Dead letter queue** (`workers/dlq-worker.js`) — exponential backoff retries (`DLQ_MAX_RETRIES`, `DLQ_BASE_DELAY_MS`), staleness sweeps, and webhook alerts.
- **Tamper-evident audit log** (`audit-log.js`) — per-tenant hash-chained, HMAC-signed trail of compliance-relevant actions (workflow submit/cancel, approvals, key create/revoke, merges, logins, user/SSO/retention changes), queryable and exportable as JSON or CSV. Set `AEGIS_AUDIT_SIGNING_KEY` in production.
- **Spend control, billing and compliance** — see [Billing](#billing) and [Compliance](#compliance).
- **Observability** — Redis-backed windowed metrics with p50/p95/p99 exported as Prometheus text (`GET /metrics`) and OTEL-compatible JSON (`GET /metrics/json`); Redis-backed execution traces (`tracer.js`); an in-process anomaly detector (success rate, p95 latency, latency spikes, retry rate); Slack/Discord/generic webhook notifications (`notifier.js`); `GET /status` dependency status.
- **Inbound triggers** — see [Inbound triggers](#inbound-triggers).
- **PR/MR automation** — in multi-repo mode, PR/MR creation uses the tenant's own credential and returns the already-open PR/MR if the branch was pushed earlier. In legacy single-repo mode, `AEGIS_PR_PROVIDER` (`github` / `gitlab` / `bitbucket`) opens a pull/merge request after a workflow merges, targeting `AEGIS_PR_TARGET_BRANCH`.
- **Prompt eval harness** (`prompt-eval.js`, `npm run eval`) — scores each agent persona against golden cases (including adversarial ones) using the real Claude API; runs as a CI gate. It checks output *format* only; it is not evidence that Aegis produces mergeable PRs (see [Evidence](#evidence-does-it-pay-for-itself)).
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

Auth: `Authorization: Bearer <key>` or `x-api-key: <key>`; SSO session tokens (`aegs_…`) are accepted wherever an API key is. Keys resolve in this order: runtime keys in the Redis key-store → `AEGIS_API_KEY_{TENANTID}` env var (only on routes that pass a tenant claim) → single-tenant `AEGIS_API_KEY` (default tenant only). Tenants whose billing status is `pending` or `suspended` receive `402` (except on billing endpoints). Write endpoints are rate-limited per tenant (`RATE_LIMIT_*`). Each route also requires a role permission (see [Access control](#access-control--sso)). See [`docs-site/docs/api-reference.md`](docs-site/docs/api-reference.md) for request/response details.

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

**Observability and public pages**

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness probe, no auth |
| GET | `/status` | Dependency status (503 when a dependency is down), no auth, no tenant data |
| GET | `/`, `/get-started`, `/terms`, `/privacy`, `/dpa`, `/security`, `/subprocessors` | Landing, signup and legal pages, no auth |
| GET | `/subprocessors.json` | Public subprocessor list (operator-only fields removed) |
| GET | `/metrics` | Prometheus text-format export |
| GET | `/metrics/json` | OTEL-compatible JSON export |
| GET | `/api/metrics` | Structured metrics (used by dashboards) |
| GET | `/anomalies` | Recent anomaly alerts |
| GET | `/dashboard` | Built-in single-file HTML dashboard |
| GET | `/events` | Live SSE stream (metrics + workflows, every 4 s) |
| GET | `/app/` | React dashboard, when `dashboard/dist` exists |

**Tenants, keys, audit**

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/tenants`, `/tenants/:id` | Tenant management |
| GET/POST/DELETE | `/tenants/:id/keys[/:keyId]` | Per-tenant API key management (key returned once; takes `role`) |
| GET | `/tenants/:id/audit-log` | Query the compliance audit trail |
| GET | `/tenants/:id/audit-log/export` | Export the audit trail (JSON or CSV) |
| GET / PUT / DELETE | `/tenants/:id/retention`, POST `/tenants/:id/data-deletion` | Retention config (admin) and tenant data deletion (`{confirm: tenantId}`) |

**Billing and spend**

| Method | Path | Purpose |
|---|---|---|
| GET | `/signup/config` | Unauthenticated; Stripe publishable key and self-serve tiers |
| POST | `/signup` | Unauthenticated self-serve signup (Stripe customer + subscription, tenant, first API key) |
| POST | `/billing/portal` | Stripe billing-portal URL (admin) |
| POST | `/billing/plan` | Change tier: free → paid, upgrade now, downgrade/cancel at period end (admin) |
| GET | `/tenants/:id/billing` | Tier + usage vs. included allowance |
| GET / PUT | `/tenants/:id/spend` | Spend-guard state; PUT sets a per-tenant cap override (operator `x-admin-key`) |
| POST | `/tenants/:id/credits` | Grant prepaid credits (operator `x-admin-key`) |
| POST | `/tenants/:id/credits/checkout` | Stripe Checkout top-up for prepaid credits (admin) |
| PUT / DELETE | `/tenants/:id/byok` | Store/remove the tenant's own Anthropic key (admin; enterprise) |

**Repository connection**

| Method | Path | Purpose |
|---|---|---|
| GET / PUT / DELETE | `/tenants/:id/repo` | Read, select, or disconnect the tenant repo |
| POST | `/tenants/:id/repo/connect` | Start connect `{ provider: github \| gitlab \| bitbucket }` |
| GET | `/tenants/:id/repo/available` | Repos the connection can access |
| GET | `/github/callback`, `/gitlab/callback`, `/bitbucket/callback` | OAuth/App install return URLs |

**Users and SSO**

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/sso/:tenantId/login` | Start OIDC single sign-on |
| GET | `/auth/sso/callback` | IdP redirect target |
| POST | `/auth/sso/exchange` | Redeem one-time code for a session token |
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
| POST | `/webhooks/github-app` | GitHub App installation lifecycle and issue-label trigger |
| POST | `/webhooks/stripe` | Stripe events that drive tenant status |

---

## Inbound triggers

- **GitHub issue label** (live) — connect a repo through the GitHub App (`deploy/github-app-manifest.json`; permissions Contents RW, Pull requests RW, Issues RW, Metadata R; event Issues). Adding the `aegis` label (`AEGIS_TRIGGER_LABEL`, per-tenant override) starts a workflow; Aegis comments on the issue at start and finish with the PR link. Triggers run the same gates as `POST /task`.
- **Slack `/aegis` and Jira label** — implemented in `engine/trigger-routes.js` and `engine/inbound-triggers.js` (routes `/webhooks/slack/command`, `/webhooks/jira/:tenantId`, `/tenants/:id/triggers/*`, `/slack/oauth/callback`; manifest in `deploy/slack-app-manifest.yml`) and covered by `tests/inbound-routes.test.js`, **but those routers are not mounted in `server.js` yet**, so the endpoints return 404 in a running server. The same applies to the GitHub Marketplace webhook (`engine/marketplace.js`, `/webhooks/github-marketplace`). Mount `triggerWebhookRouter`, `triggerRouter` and `marketplaceRouter` to enable them. Details: [`docs-site/docs/integrations.md`](docs-site/docs/integrations.md).

---

## Access control & SSO

**Roles.** Every credential has one: `viewer` (read-only), `member` (+ run, cancel, resume, rewind workflows; resolve reviews), `admin` (+ API keys, users, audit log, retention, BYOK, billing actions). The permission table is `engine/rbac.js`. API keys get a role at creation (`POST /tenants/:id/keys {"role":"member"}`, default `member`); keys from before roles existed and env-var keys are `admin`.

**SSO (OIDC).** Set `AEGIS_PUBLIC_URL`, `AEGIS_TOKEN_ENCRYPTION_KEY`, `AEGIS_ADMIN_KEY` and (for the React dashboard) `AEGIS_DASHBOARD_URL`. Register `<AEGIS_PUBLIC_URL>/auth/sso/callback` as the redirect URI at your IdP, then, as the operator:

```bash
curl -X PUT $AEGIS/tenants/acme/sso -H "x-admin-key: $AEGIS_ADMIN_KEY" -H 'content-type: application/json' -d '{
  "issuer": "https://acme.okta.com", "clientId": "…", "clientSecret": "…",
  "allowedDomains": ["acme.com"], "jitRole": "viewer"
}'
```

Pre-provision admins with `POST /tenants/acme/users {"email":"jo@acme.com","role":"admin"}`; anyone else from an allowed domain is created at `jitRole` (never `admin`; omit `jitRole` to allow only pre-provisioned users). The first login binds the IdP `sub` to the user. Sessions last `AEGIS_SESSION_TTL_HOURS` (default 8); disabling a user or changing their role applies immediately. SAML is not supported (use an OIDC bridge).

**Dashboard.** Admins get *Users* (add, change role, disable) and *Audit log* (who did what, hash-chain status, CSV export) pages; UI controls follow the signed-in role.

**Audit identity.** Audit events record `actorType` (`user` / `api-key`), `actorId`, `actorEmail`, `actorRole` and `ip`; logins, logouts, denied logins, user changes and SSO changes are audited, and API keys record who created them.

---

## Billing

Billing is optional. A deployment without Stripe or Postgres still runs; usage simply isn't metered.

- **Tiers** (`engine/billing/tiers.js`) — `free`, `starter` (default for existing tenants), `pro`, and `enterprise`. Each defines hard quota ceilings (`maxActiveWorkflows`, `maxDailyWorkflows`, `maxQueuedJobs`), a spend ceiling, and an included monthly allowance for five metered dimensions: workflow runs, agent steps, input tokens, output tokens, and sandbox minutes. Input and output tokens are separate meters because output costs 5x input ($3/M vs $15/M for Claude Sonnet). Enterprise allowances are unlimited.
- **Free tier** (`free-tier.js`) — no card, no Stripe objects; allowances are *hard* limits (workflow runs and sandbox minutes checked at admission, tokens bounded by the spend cap, `fails closed` if usage can't be read). All free-tier numbers are marked provisional until checked with `scripts/measure-cost.js` and `scripts/propose-pricing.js`.
- **Hard spend control** (`spend-guard.js`) — `checkAllowance` is informational (it drives overage billing); enforcement is the spend guard. Every platform-key call reserves its worst-case cost atomically (Redis Lua) before it is sent and settles to actual usage afterwards; an unreachable Redis refuses the call. Modes: `capped` (monthly UTC ceiling from the tier, or a per-tenant override) and `prepaid` (credits topped up via Stripe Checkout, idempotent on the event id). Stripe-backed tenants are held to `AEGIS_UNVERIFIED_CAP_USD` (default $5) until their first paid invoice clears, and suspended tenants can't spend from an already-running workflow.
- **BYOK** (`byok.js`) — enterprise tenants can store their own Anthropic key (sealed with `AEGIS_TOKEN_ENCRYPTION_KEY`); BYOK calls skip the platform cap and token metering and never fall back to the platform key.
- **Metering** — every billable action is appended to an immutable `usage_events` table in Postgres (`DATABASE_URL`). This is separate from `tenant-quota.js`, which only holds live rate-limit counters in Redis.
- **Reporting** — `npm run billing:flush` pushes unreported usage to Stripe's metered billing API. Run it on a schedule (hourly cron, the k8s CronJob, or the Render cron in `render.yaml`). Without `STRIPE_SECRET_KEY` it fails closed and usage keeps accumulating.
- **Signup** — `/get-started` calls `POST /signup`, which creates a Stripe customer and subscription, registers the tenant as `pending`, and issues a first API key. The key is unusable (`402`) until the first payment succeeds and Stripe's `invoice.paid` webhook flips the tenant to `active`. Self-serve signup requires an authenticated remote sandbox runner (see [Deployment](#deployment)) unless `AEGIS_ALLOW_UNSANDBOXED_SIGNUP=true`.
- **Plan changes** — `POST /billing/plan` (free → paid, upgrade now, downgrade/cancel at period end).
- **Tax** (`tax.js`) — `AEGIS_TAX_MODE=off` (default) | `stripe` (Stripe Tax) | `gst` (India-based seller: CGST+SGST / IGST / export by place of supply; needs `AEGIS_TAX_HOME_STATE` and `STRIPE_TAXRATE_IN_*`).
- **Tenant status** — `POST /webhooks/stripe` (signature-verified with `STRIPE_WEBHOOK_SECRET`) sets tenants `active` on `invoice.paid`, and `suspended` on `invoice.payment_failed` or subscription deletion/past-due. Subscribe the endpoint to `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, and `customer.subscription.updated`.
- **Cleanup** — `npm run billing:cleanup` removes (or reconciles) self-serve signups that never paid; defaults to tenants pending longer than 48 h, supports `--hours=N` and `--dry-run`.
- **One-time Stripe setup** — `node scripts/stripe-setup.js` creates the Billing Meters and prices and prints the `STRIPE_PRICE_*` env lines. Use a test-mode key first; it is not idempotent, and it refuses token overage priced below provider cost unless `ALLOW_BELOW_COST=1`. Upgrading from the single `tokens` meter: see the migration note in the changelog (`npm run billing:migrate-tokens`).
- **Design partners** — `npm run onboard -- <tenantId> [label] [tier]` registers a tenant and issues a key directly, with no running server or Stripe involved.

See [`docs-site/docs/billing.md`](docs-site/docs/billing.md) for details.

---

## Compliance

- **Retention** — per-tenant retention config (`GET|PUT /tenants/:id/retention`, admin) with an in-process scheduler started at boot and a `npm run retention:sweep` CronJob. Zero-retention mode sweeps immediately when enabled and redacts the task text before it is hashed into the audit chain.
- **Data deletion** — `POST /tenants/:id/data-deletion` with `{confirm: tenantId}`; audited as `data.deleted`.
- **Legal pages** — `/terms`, `/privacy`, `/dpa`, `/security`, `/subprocessors` (rendered from `compliance/subprocessors.json`).
- **Launch gate** — `npm run compliance:check` fails until subprocessor retention terms are confirmed, counsel has reviewed the legal pages (`compliance/launch-signoff.json`), the DRAFT banners are removed, and the sandbox runner config is production-ready. SOC 2 is a roadmap, not a certification: see [`docs-site/docs/soc2-roadmap.md`](docs-site/docs/soc2-roadmap.md) and [`docs-site/docs/compliance.md`](docs-site/docs/compliance.md).

---

## Dashboards

- **Built-in** — `GET /dashboard` serves a self-contained HTML page (`engine/dashboard.html`) fed by the `/events` SSE stream. No build step.
- **React dashboard** (`dashboard/`) — React 19 + Vite app with pages for Login, Overview, Workflows (and workflow detail), Review Queue, DLQ, Traces, Anomalies, Billing, Tenants, Users and Audit log. Sign in with an API key or SSO. `server.js` serves the built app at `/app/` when `dashboard/dist` exists (the Docker image builds it):

  ```bash
  npm run build:dashboard      # then start the server and open http://localhost:3000/app/
  cd dashboard && npm run dev  # dev server; set VITE_AEGIS_API_URL to your API base URL
  ```

  When serving it from the API, set `AEGIS_DASHBOARD_URL` to `<AEGIS_PUBLIC_URL>/app/`.

- **Prometheus / Grafana** — scrape `/metrics`; alert rules are in `monitoring/aegis-alerts.yml` and a dashboard in `monitoring/aegis-dashboard.json`.

---

## Configuration

Configuration is environment-variable driven — see `.env.example` for the full, documented list and [`docs-site/docs/configuration.md`](docs-site/docs/configuration.md). Highlights:

```bash
ANTHROPIC_API_KEY=...          # required — all agent LLM calls
OPENAI_API_KEY=...             # optional — enables vector memory embeddings
AEGIS_MODEL_BUILD=...          # optional — model for patch/test agents (default Sonnet)
AEGIS_MODEL_CHEAP=...          # optional — model for planner + review-guard (default Haiku)
AEGIS_CAP_FALLBACK=1           # 0 = refuse at the spend cap instead of downgrading to CHEAP
REDIS_URL=redis://...          # Redis Stack
DATABASE_URL=postgres://...    # optional — usage metering / billing
AEGIS_API_KEY_DEFAULT=...      # per-tenant API key(s)
AEGIS_TENANTS=default          # tenants registered at boot
AEGIS_REPOS_BASE=/repos        # per-tenant repos (default in deploy configs)
AEGIS_PUBLIC_URL=...           # SSO, OAuth callbacks
AEGIS_TOKEN_ENCRYPTION_KEY=... # seals repo tokens, IdP secrets, BYOK keys
AEGIS_ADMIN_KEY=...            # operator endpoints (SSO config, spend, credits)
PORT=3000
QUEUE_BACKEND=bullmq           # or sqs | redis-streams
CLAUDE_AUTONOMY=true           # false = every patch held for human review
AEGIS_SANDBOX_MODE=            # 'local' bypasses Docker (dev only, never prod)
DOCKER_HOST=                   # remote sandbox runner (mutual TLS); forces stream transport
AEGIS_MERGE_STRATEGY=rebase    # or 'flag'
AEGIS_AUDIT_SIGNING_KEY=...    # required in production
AEGIS_INJECTION_MODE=block     # or 'flag'
AEGIS_UNVERIFIED_CAP_USD=5     # spend cap until first paid invoice
DLQ_MAX_RETRIES=2
STRIPE_SECRET_KEY=...          # optional — billing
STRIPE_WEBHOOK_SECRET=...      # optional — billing
```

GitHub App (`AEGIS_GITHUB_APP_*`), GitLab/Bitbucket OAuth, Slack/Jira trigger settings, retention, tax, vector memory reranking, concurrency limits per priority tier, rate limits, DLQ backoff, anomaly thresholds, legacy PR automation and Slack/Discord webhooks are all separately tunable.

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
npm run bench:verify   # ROI benchmark: each task is a valid problem (no LLM)
npm run bench:selftest # ROI benchmark: harness check, synthetic, not evidence
npm run compliance:check  # pre-launch compliance gate (fails until signed off)
npm run check          # lint + coverage
```

The unit suite (`tests/`) covers agent-runner, approval-gate, audit-log (incl. identity and zero-retention), auth/billing gate, RBAC, SSO and sessions, billing tiers/allowance/free tier/plan change/tax/pricing model, spend guard and BYOK, concurrency, the git engine and providers, GitHub App and per-tenant repo OAuth, inbound triggers and routes, the pipeline, prompt-eval and prompt-guard, repo-scanner and language analyzers, toolchains and deps-cache, retention, retry-policy, review-system, sandbox stream/fail-closed behavior, signup, Stripe reporter/webhook, pending-cleanup, usage-recorder, vector-memory, workflow-store, and the bench/case-study tooling.

The system suite (`tests/integration/system/`) exercises the Docker sandbox (including the stream transport), git worktrees, the end-to-end pipeline, and the BullMQ/Redis Streams/SQS queue backends against real infrastructure. These need a live Docker daemon and Redis (Redis Stack for FT.SEARCH-backed vector memory); the Docker sandbox tests skip themselves when Docker isn't reachable.

**CI** (`.github/workflows/ci.yml`) runs lint + unit tests with coverage, then system tests, then the prompt eval gate. The eval step is skipped on fork PRs without secrets and is non-blocking if the Claude API is unreachable.

---

## Deployment

### One-click (trial / eval)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Naveenub/aegis)

`render.yaml` provisions Postgres, a Redis Stack private service, a single combined web service (server + worker + dlq-worker sharing one disk), and an hourly billing-flush cron. You'll be prompted for `ANTHROPIC_API_KEY` during setup. Tenant code never runs on the web service: set `DOCKER_HOST` (mutual TLS), the `ca.pem`/`cert.pem`/`key.pem` Secret Files and `AEGIS_SANDBOX_IMAGE` (built from `Dockerfile.sandbox`) to point it at an isolated remote runner (see `scripts/provision-runner.sh`); without them lint/test steps are blocked and self-serve signup stays off. The worktree is streamed to the runner as a tar (no host paths, no `.git`), so only stdout comes back. This topology trades away horizontal worker scaling in exchange for a deploy with no nested Docker. Fork the repo first if you're deploying your own copy.

### Docker Compose (dev / single-tenant)

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
docker compose up -d --build
```

This starts `redis` (Redis Stack), `postgres`, `server` (port 3000), `worker`, `dlq-worker`, a rootless `dind` sidecar, and a one-shot `sandbox-image` service that builds the sandbox image inside `dind`. Two things worth knowing:

- **`worker` talks to a rootless Docker-in-Docker sidecar (`dind`), not the host socket**, capping a sandbox compromise at that sidecar's unprivileged UID. The compose `dind` is plaintext and local, so it is for development and single-tenant use only; self-serve signup refuses it unless `AEGIS_ALLOW_UNSANDBOXED_SIGNUP=true`. For multi-tenant use, point `DOCKER_HOST` at an authenticated remote runner (`scripts/provision-runner.sh`).
- **`server` and `worker` share a `repo` volume** so repo paths resolve to the same checkout across both processes.

### Kubernetes

Manifests under `k8s/` cover the namespace, configmap, Redis Stack, repo PVC, server/worker/dlq-worker deployments, a mutual-TLS sandbox runner (`06a-sandbox.yaml`), HPA, ingress, and three CronJobs (billing flush, pending-signup cleanup, retention sweep). Apply with `kubectl apply -k k8s/`. Read `k8s/README.md` first — it covers the `ReadWriteMany` storage requirement, the sandbox TLS Secrets and privileged `dind` caveat, and the single-replica server constraint.

See [`docs-site/docs/deployment.md`](docs-site/docs/deployment.md) for more.

---

## Evidence: does it pay for itself?

The prompt eval only scores whether personas follow their output format. ROI is measured separately, on real repos, by outcomes:

| Metric | How it is measured |
|---|---|
| Verified merge rate | Aegis's branch merged **and** the original PR's held-out tests (never shown to Aegis) pass, with a 95% Wilson interval |
| Cost per merged PR | All LLM spend from the engine's own counter, failed attempts and retries included |
| Time saved | Per PR: baseline minutes − review − fix-up; failures count as lost review time. Only where human time was recorded; never estimated |

```bash
npm run bench:verify                        # 8 tasks / 4 public repos re-verified (no LLM)
npm run bench                               # real run: ANTHROPIC_API_KEY + dedicated Redis Stack + Docker
npm run bench:report -- bench/results/<runId> --hourly-usd 120
npm run case-study -- export <tenantId>     # design-partner ledger, then `render`
npm run measure-cost                        # measured cost per workflow, feeds propose-pricing
```

**Status (honest):** the harness, 8 verified tasks and the case-study generator are built and tested. **No published Aegis results and no named design-partner case study exist yet**; both are produced only by running the commands above, never written by hand. Methodology and limits: [`bench/README.md`](bench/README.md), [ROI benchmark](docs-site/docs/benchmark.md), [design-partner protocol](docs-site/docs/case-studies/pilot-protocol.md).

---

## Documentation

The Docusaurus site in `docs-site/` covers the intro, quickstart, architecture, configuration, API reference, billing, inbound triggers, compliance and SOC 2 roadmap, launch checklist, deployment, testing, the ROI benchmark and case-study protocol, and a candid [failure-modes](docs-site/docs/FAILURE_MODES.md) register. Run it locally with:

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
