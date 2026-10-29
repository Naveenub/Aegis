# AEGIS: Multi-Tenant AI Agent Orchestration Engine

> A Git-backed, DAG-driven pipeline that turns a task description into an executed, tested, reviewable patch — with Docker sandboxing, distributed locking, per-tenant isolation, and metered billing.

[![Version](https://img.shields.io/badge/version-v2.0.0-blue)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)]()

> **v2.0.0** plus the changes listed under *Unreleased* in [CHANGELOG.md](CHANGELOG.md) (SSO/RBAC, spend control, per-tenant repos, retention and compliance pack). Full documentation lives in [`docs-site/`](docs-site/) (Docusaurus).

---

## What AEGIS is

AEGIS is a Node.js (ESM, Node 20+) service that takes a task description, has an LLM planner decompose it into a dependency graph of steps, and executes each step through one of seven specialized agents. Each step's patch is generated, structurally validated, applied to an isolated Git worktree, linted and tested inside a Docker sandbox, and either committed or rolled back — all under Redis-backed distributed locks so multiple tenants and workflows can run concurrently without stepping on each other.

It is a REST API (`server.js`) plus a queue-backed worker pool (`workers/`), not a library you `import`. Around that core sit multi-tenant auth (API keys, OIDC SSO, roles), quotas and hard per-tenant LLM spend caps, a tamper-evident audit trail, Stripe-based metered billing, per-tenant repository connections (GitHub App, GitLab, Bitbucket), configurable data retention, observability (Prometheus/OTEL, anomaly detection, two dashboards), and deployment manifests for Docker Compose, Kubernetes, and Render.

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

Every platform-key LLM call ──▶ spend-guard.js: reserve worst-case cost
                                (atomic Redis Lua) → call → settle to actual

Every billable action ──▶ usage-recorder.js (Postgres, append-only)
                          └─▶ stripe-reporter.js (scheduled flush to Stripe)
```

Agent inputs include AST-level repo context (symbol tables, import/call graphs) from `repo-scanner.js`, and prior-fix context pulled from `vector-memory.js` (hybrid cosine + BM25 + recency search over OpenAI embeddings, when `OPENAI_API_KEY` is set — otherwise memory is a no-op and everything else still works). Repository files, symbol names, test output and memory are treated as untrusted data and passed through `prompt-guard.js` before they reach a prompt.

### Repository layout

| Path | Contents |
|---|---|
| `server.js` | Express API server; wires routes, middleware, webhooks, anomaly detector |
| `workers/` | `agent-worker.js` (step execution) and `dlq-worker.js` (retry/escalation) |
| `engine/` | Orchestrator, agents, sandbox, git, queue, locks, memory, metrics, audit log, tenants, quotas. Smaller modules: `lock.js` (Redlock, tenant-scoped), `code-writer.js` (patch application), `lint-runner.js` / `test-runner.js` (run via the sandbox), `toolchains.js` (per-language lint/test profiles), `deps-cache.js` (network-enabled dependency install, cached), `prompt-guard.js` (prompt-injection defences), `job-store.js` (Redis-backed job records), `queue.js` (public queue surface over the adapter) |
| `engine/` (access) | `rbac.js` (roles/permissions), `sso.js` (OIDC), `auth-routes.js` (SSO, `/auth/*`, user and SSO admin routes), `user-store.js`, `key-store.js` |
| `engine/` (repos) | `repo-routes.js`, `repo-store.js`, `tenant-repo.js`, `github-app.js`, `cred-store.js`, `token-vault.js`, `oauth-state.js`, `engine/providers/` (GitLab and Bitbucket OAuth/API clients) |
| `engine/` (data lifecycle) | `retention.js`, `retention-policy.js`, `retention-scheduler.js`, `workflow-purge.js`, `compliance-pages.js` |
| `engine/adapters/` | Queue backends: `bullmq-adapter`, `sqs-adapter`, `redis-streams-adapter`, plus shared `priority-tiers` |
| `engine/billing/` | Tiers, allowance checks, free-tier limits, spend guard, prepaid credits, BYOK, plan changes, signup, Stripe customer/reporter/webhook, pricing model, pending-signup cleanup |
| `middleware/` | `auth.js` (API keys, tenant status gate) and `rate-limit.js` (Redis-backed) |
| `cli/claude.js` | Submit a task and poll to completion |
| `scripts/` | Billing flush/cleanup/migrations, Stripe setup, cost measurement and pricing proposal, retention sweep, compliance check, partner onboarding, DLQ inspection, prompt eval, case-study export, sandbox runner provisioning, CI pipeline |
| `bench/` | ROI benchmark harness, verified tasks and report generator (see [Evidence](#evidence-does-it-pay-for-itself)) |
| `compliance/` | `subprocessors.json` (source for the subprocessor page/JSON) and `launch-signoff.json` (counsel sign-off) |
| `sandbox/`, `Dockerfile.sandbox` | Sandbox runner images used when lint/test runs on a remote or sidecar Docker daemon |
| `.claude/` | `agents/` persona prompts (`planner`, `feature-builder`, `debugger`, …), `settings.json`, and `context/` runtime snapshots (`jobs.json`, `memory.json`, `decisions.log`) |
| `dashboard/` | React 19 + Vite operator dashboard (separate app) |
| `App.jsx`, `api/`, `components/`, `pages/` | Root-level dashboard source copies (including a `Billing` page); the maintained app is under `dashboard/src/` |
| `docs-site/` | Docusaurus documentation site |
| `monitoring/` | Prometheus alert rules and a dashboard JSON |
| `k8s/` | Kustomize manifests |
| `landing/` | Static pages served by `server.js`: `index.html` (`/`), `signup.html` (`/get-started`), `terms.html` (`/terms`), `privacy.html` (`/privacy`), `dpa.html` (`/dpa`), `security.html` (`/security`), `subprocessors.html` (`/subprocessors`) |
| `tests/` | Vitest unit tests; `tests/integration/system/` for real-infrastructure tests |

---

## Core components

- **DAG-based planning** (`orchestrator.js`) — LLM produces a plan as JSON tasks with `depends_on`; the engine validates structure, rejects forward references, and detects cycles via Kahn's algorithm before anything runs.
- **Seven agent types** (`agent-runner.js`) — `feature-builder`, `debugger`, `refactorer`, `test-writer`, `security-editor`, `review-guard`, and `meta-reviewer` (fallback agent used on retry attempt 3+ by `retry-policy.js`). Personas are plain Markdown in `.claude/agents/` (alongside the `planner` persona).
- **Model routing** (`agent-runner.js`) — `planner` and `review-guard` use a cheap model (`AEGIS_MODEL_CHEAP`, default Haiku 4.5); every other agent uses the build model (`AEGIS_MODEL_BUILD`, default Sonnet 4). `AEGIS_MODEL` pins both tiers. When a tenant's build-tier spend reservation hits the cap, the call is retried once on the cheap model and flagged `capFallback` (`AEGIS_CAP_FALLBACK=0` refuses instead). BYOK tenants never downgrade.
- **Retry policy** (`retry-policy.js`) — presets (`STANDARD`, `IO_BOUND`, `CODE_GEN`, `REVIEW`) with exponential backoff; attempt 2 escalates to `debugger`, attempt 3+ to `meta-reviewer`. See [`docs-site/docs/FAILURE_MODES.md`](docs-site/docs/FAILURE_MODES.md) for known gaps.
- **Workflow templates** (`template-store.js`) — freeze a validated task + plan, version it, diff versions, and re-run it without invoking the planner.
- **Docker sandbox** (`sandbox.js`) — every lint/test run for a generated patch executes inside a Docker container by default. If Docker is unavailable, it hard-fails the step *unless* `AEGIS_SANDBOX_MODE=local`, `AEGIS_SANDBOX_DISABLE=true`, or `CI=true` is set — each of those falls back to direct host execution with a loud warning. Never leave those set in production. Lint and tests run per language, detected from marker files at the worktree root: JavaScript/TypeScript (ESLint + Vitest), Python (pytest or unittest, ruff when available), Go (`gofmt` + `go vet` + `go test`) and Java (Maven or Gradle); a polyglot repo runs each. The sandbox has no network, so dependencies are installed beforehand in a separate network-enabled container (`engine/deps-cache.js`, cached per manifest hash, mounted read-only into the runs); `AEGIS_SANDBOX_AUTO_DEPS=off` disables that and `AEGIS_SANDBOX_*_DEPS` supplies caches by hand — see `.env.example`. A repo with no supported language fails lint/tests rather than passing unverified. The repo scanner that feeds agents their symbol/import/call context covers the same languages.
- **Git-based rollback** (`git.js`, `git-remote.js`) — each workflow gets its own worktree and branch; steps commit or roll back; `finaliseWorkflow()` merges and can rebase-and-retry on conflicts (`AEGIS_MERGE_STRATEGY`). In multi-repo mode each tenant has a base branch (`aegis-tenant/<id>`) that is merged with the default-branch tip before new workflows branch from it and before each merge (`AEGIS_BASE_SYNC=off` disables).
- **Per-tenant repositories** (`repo-routes.js`, `tenant-repo.js`, `github-app.js`) — set `AEGIS_REPOS_BASE` to give each tenant its own clone and worktrees. Tenants connect GitHub through a GitHub App (no PATs), or GitLab/Bitbucket Cloud through OAuth 2.0; provider tokens are sealed with AES-256-GCM (`AEGIS_TOKEN_ENCRYPTION_KEY`) and refreshed on demand. Without `AEGIS_REPOS_BASE`, the legacy single-repo mode (`AEGIS_REPO_ROOT`) applies.
- **Step rewind** — git-revert a specific step and reset dependent steps, with a full audit trail.
- **Pluggable queue backend** (`queue-adapter.js`) — `QUEUE_BACKEND=bullmq` (default), `sqs`, or `redis-streams`. SQS and Redis Streams have no native priority, so they fan out to four queues/streams per tenant (critical/high/normal/low).
- **Concurrency control** (`concurrency.js`) — lease-based per-workflow slots by priority tier; crashed workers' slots expire via `AEGIS_CONCURRENCY_LEASE_MS`.
- **Idempotency** (`idempotency.js`) — tenant-scoped idempotency keys (default 7-day TTL) so retries don't re-apply patches.
- **Multi-tenancy** (`tenant.js`, `tenant-registry.js`, `tenant-quota.js`, `key-store.js`) — per-tenant API keys (runtime-managed in Redis, with env-var fallback), quotas, tenant status, and isolated worktrees/queues.
- **Roles and SSO** (`rbac.js`, `sso.js`, `auth-routes.js`) — `viewer` / `member` / `admin` roles on every credential, per-tenant OIDC single sign-on, and revocable session tokens. See [Access control & SSO](#access-control--sso).
- **Spend control** (`billing/spend-guard.js`) — hard per-tenant LLM cost ceilings enforced before each call, prepaid credits, and bring-your-own Anthropic key for enterprise. See [Billing](#billing).
- **Data retention and compliance** (`retention*.js`, `workflow-purge.js`) — per-tenant retention windows, a zero-retention mode, on-request data deletion, and a pre-launch compliance gate. See [Data retention & compliance](#data-retention--compliance).
- **Human-in-the-loop** (`approval-gate.js`) — `CLAUDE_AUTONOMY=false` or `MODE=approval` holds every patch for review; individual steps can also set `requiresApproval`.
- **Vector memory** (`vector-memory.js`) — Redis Stack (`FT.SEARCH`) backed store with a hybrid cosine + BM25 + recency reranker, per-tenant adaptive weight feedback, and a TTL eviction cron. Requires `OPENAI_API_KEY` for embeddings; degrades gracefully to a no-op without it. On plain Redis (no Stack), `initVectorIndex()` **fails fast** with a descriptive error rather than silently desyncing across containers; set `AEGIS_ALLOW_HNSW_FALLBACK=true` only for a single-process dev setup.
- **Dead letter queue** (`workers/dlq-worker.js`) — exponential backoff retries (`DLQ_MAX_RETRIES`, `DLQ_BASE_DELAY_MS`), staleness sweeps, and webhook alerts.
- **Tamper-evident audit log** (`audit-log.js`) — per-tenant hash-chained, HMAC-signed trail of compliance-relevant actions (workflow submit/cancel, approvals, key create/revoke, merges, logins, user/SSO/retention changes), recording the acting user or key, role and IP. Queryable and exportable as JSON or CSV. Set `AEGIS_AUDIT_SIGNING_KEY` in production.
- **Metered billing** (`engine/billing/`, `usage-recorder.js`) — see [Billing](#billing).
- **Observability** — Redis-backed windowed metrics with p50/p95/p99 exported as Prometheus text (`GET /metrics`) and OTEL-compatible JSON (`GET /metrics/json`); Redis-backed execution traces (`tracer.js`); an in-process anomaly detector (success rate, p95 latency, latency spikes, retry rate); Slack/Discord/generic webhook notifications (`notifier.js`).
- **Inbound webhooks** (`webhook-receiver.js`) — signature-verified GitHub/GitLab push and PR/MR webhooks can trigger workflows, filtered by branch pattern. GitHub App events arrive on `/webhooks/github-app`.
- **PR/MR automation** — `AEGIS_PR_PROVIDER` (`github` / `gitlab` / `bitbucket`) opens a pull/merge request after a workflow merges, targeting `AEGIS_PR_TARGET_BRANCH`. In multi-repo mode the tenant's own credential is used, and an already-open PR/MR is returned instead of failing.
- **AST-based repo intelligence** (`repo-scanner.js`) — built on `acorn`; produces symbol tables and import/call graphs to give agents accurate repo context.
- **Prompt eval harness** (`prompt-eval.js`, `npm run eval`) — scores each agent persona against golden cases using the real Claude API; runs as a CI gate so a bad persona edit is caught before it ships. It checks output *format* only; it is not evidence that Aegis produces mergeable PRs (see [Evidence](#evidence-does-it-pay-for-itself)).
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

Auth: `Authorization: Bearer <key>` or `x-api-key: <key>`. Keys resolve in this order: runtime keys in the Redis key-store → `AEGIS_API_KEY_{TENANTID}` env var → single-tenant `AEGIS_API_KEY` (default tenant only). Session tokens from SSO (`aegs_…`) are accepted wherever an API key is. Tenants whose billing status is `pending` or `suspended` receive `402` (except on billing endpoints). Write endpoints are rate-limited per tenant (`RATE_LIMIT_*`). See [`docs-site/docs/api-reference.md`](docs-site/docs/api-reference.md) for request/response details.

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
| GET | `/`, `/get-started`, `/terms`, `/privacy`, `/dpa`, `/security`, `/subprocessors` | Landing, signup, and legal/trust pages, no auth |
| GET | `/subprocessors.json` | Machine-readable subprocessor list (operator-only fields removed), no auth |
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
| POST | `/billing/portal` | Stripe billing-portal URL (admin) |
| POST | `/billing/plan` | Change tier: free → paid, upgrade now, downgrade/cancel at period end (admin) |
| GET/POST | `/tenants`, `/tenants/:id` | Tenant management |
| GET | `/tenants/:id/billing` | Tier + usage vs. included allowance |
| GET / PUT | `/tenants/:id/spend` | Read spend state / set a per-tenant cap or mode (`PUT` is operator-only, `x-admin-key`) |
| POST | `/tenants/:id/credits` | Grant prepaid credits (operator-only, `x-admin-key`) |
| POST | `/tenants/:id/credits/checkout` | Stripe Checkout session for a credit top-up (admin) |
| PUT / DELETE | `/tenants/:id/byok` | Store / remove the tenant's own Anthropic key (admin; enterprise tier) |
| GET / PUT | `/tenants/:id/retention` | Read / set the data-retention policy and zero-retention flag (admin) |
| POST | `/tenants/:id/data-deletion` | Delete a tenant's stored content; body must include `{ "confirm": "<tenantId>" }` (admin) |
| GET/POST/DELETE | `/tenants/:id/keys[/:keyId]` | Per-tenant API key management (key is returned once on creation) |
| GET | `/tenants/:id/audit-log` | Query the compliance audit trail |
| GET | `/tenants/:id/audit-log/export` | Export the audit trail (JSON or CSV) |
| GET | `/auth/sso/:tenantId/login` | Start OIDC single sign-on |
| GET | `/auth/sso/callback` | OIDC redirect URI (register this at your IdP) |
| POST | `/auth/sso/exchange` | Exchange the SSO result for a session token (used by the dashboard) |
| GET | `/auth/me` | Who am I: identity, role, permissions (API key or session) |
| POST | `/auth/logout` | End an SSO session |
| GET / POST | `/tenants/:id/users` | List / pre-provision users (admin) |
| PATCH | `/tenants/:id/users/:userId` | Change a user's role or disable them (admin) |
| GET / PUT / DELETE | `/tenants/:id/sso` | SSO config (read: admin; write: operator `x-admin-key`) |

**Tenant repositories** (multi-repo mode, `AEGIS_REPOS_BASE`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/tenants/:id/repo` | Current repository binding and clone status |
| POST | `/tenants/:id/repo/connect` | Start connecting a repo; body `{ "provider": "github" \| "gitlab" \| "bitbucket" }` (default `github`) |
| GET | `/github/callback`, `/gitlab/callback`, `/bitbucket/callback` | Browser return from the provider |
| GET | `/tenants/:id/repo/available` | Repositories the connection can access |
| PUT | `/tenants/:id/repo` | Select the repository and branches to use |
| DELETE | `/tenants/:id/repo` | Disconnect (GitHub App stays installed until the customer removes it) |

**Inbound webhooks** (authenticated by signature, not API key)

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhooks/github` | GitHub push / pull_request events |
| POST | `/webhooks/gitlab` | GitLab push / merge-request events |
| POST | `/webhooks/github-app` | GitHub App installation and repository events |
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

**Dashboard.** Admins get *Users* (add, change role, disable) and *Audit log* (who did what, hash-chain status, CSV export) pages; UI controls follow the signed-in role.

**Audit identity.** Audit events record `actorType` (`user` / `api-key`), `actorId`, `actorEmail`, `actorRole` and `ip`; logins, logouts, denied logins, user changes and SSO changes are audited, and API keys record who created them.

## Billing

Billing is optional. A deployment without Stripe or Postgres still runs; usage simply isn't metered. LLM spend is bounded separately from billing (see *Spend control*).

- **Tiers** (`engine/billing/tiers.js`) — `free` (default for self-serve signup, no card, hard limits), `starter` (default for tenants with no stored tier), `pro`, and `enterprise`. Each defines hard quota ceilings (`maxActiveWorkflows`, `maxDailyWorkflows`, `maxQueuedJobs`), a monthly LLM spend cap, and an included monthly allowance for five metered dimensions: workflow runs, agent steps, input tokens, output tokens, and sandbox minutes. On paid tiers the allowance is the free band before overage; on `free` it is enforced as a hard limit (`free-tier.js`). The free-tier numbers are provisional until checked with `measure-cost` and `propose-pricing`. Input and output tokens are separate meters because output costs 5x input ($3/M vs $15/M for Claude Sonnet); one summed meter would let output-heavy tenants run at negative margin. Enterprise allowances are unlimited.
- **Spend control** (`spend-guard.js`) — every platform-key LLM call reserves its worst-case cost atomically in Redis before it is sent and settles to actual usage afterwards, so concurrent workers and retries cannot overshoot the cap; an unreachable Redis refuses the call. Modes: `capped` (monthly UTC ceiling from the tier, or a per-tenant override via `PUT /tenants/:id/spend`) and `prepaid` (credits bought through Stripe Checkout). Stripe-backed tenants are held to `AEGIS_UNVERIFIED_CAP_USD` (default $5) until their first paid invoice clears. Enterprise tenants can supply their own Anthropic key (`PUT /tenants/:id/byok`): those calls skip the platform cap and token metering and never fall back to the platform key.
- **Metering** — every billable action is appended to an immutable `usage_events` table in Postgres (`DATABASE_URL`). This is separate from `tenant-quota.js`, which only holds live rate-limit counters in Redis.
- **Reporting** — `npm run billing:flush` pushes unreported usage to Stripe's metered billing API. Run it on a schedule (hourly cron, the k8s CronJob, or the Render cron in `render.yaml`). Without `STRIPE_SECRET_KEY` it fails closed and usage keeps accumulating.
- **Signup page** — `/get-started` is a built-in page that calls `POST /signup` and confirms the first payment with Stripe.js. Set `STRIPE_PUBLISHABLE_KEY`; the landing page's pricing buttons link to it.
- **Signup** — `POST /signup` creates a Stripe customer and subscription, registers the tenant as `pending`, and issues a first API key. The key is unusable (`402`) until the first payment succeeds and Stripe's `invoice.paid` webhook flips the tenant to `active`.
- **Tenant status** — `POST /webhooks/stripe` (signature-verified with `STRIPE_WEBHOOK_SECRET`) sets tenants `active` on `invoice.paid`, and `suspended` on `invoice.payment_failed` or subscription deletion/past-due. Subscribe the endpoint to `checkout.session.completed` (also fulfils credit top-ups), `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, and `customer.subscription.updated`.
- **Cleanup** — `npm run billing:cleanup` removes (or reconciles) self-serve signups that never paid; defaults to tenants pending longer than 48 h, supports `--hours=N` and `--dry-run`.
- **One-time Stripe setup** — `node scripts/stripe-setup.js` creates the Billing Meters and prices and prints the `STRIPE_PRICE_*` env lines. Use a test-mode key first; it is not idempotent.
- **Plan changes** — `POST /billing/plan` (`plan-change.js`): free → paid creates a subscription and returns a `clientSecret` to confirm with Stripe.js; starter → pro upgrades now with proration; downgrades and cancellation take effect at period end.
- **Pricing tooling** — `npm run measure-cost` measures real cost per workflow from `usage_events`; `scripts/propose-pricing.js` turns that into the prices `stripe-setup.js` needs and checks every tier against them. Nothing defaults a price.
- **Design partners** — `npm run onboard -- <tenantId> [label] [tier]` registers a tenant and issues a key directly, with no running server or Stripe involved.

See [`docs-site/docs/billing.md`](docs-site/docs/billing.md) for details.

---

## Data retention & compliance

- **Retention** — each tenant has an effective policy (days, 1–365, per content type; `null` falls back to the platform default) set with `PUT /tenants/:id/retention`. `npm run retention:sweep` enforces it (daily k8s CronJob / Render cron), and the API server runs the same idempotent sweep in-process as a safety net (`AEGIS_RETENTION_INPROCESS=off` disables).
- **Zero-retention mode** — keeps ids, statuses and timestamps (so polling and billing still work) but scrubs step content, traces and review data, stops writing new vector memory, and redacts the task excerpt before it enters the audit hash chain. Enabling it sweeps the tenant immediately.
- **Deletion on request** — `POST /tenants/:id/data-deletion` with `{ "confirm": "<tenantId>" }` removes a tenant's stored content and is audited as `data.deleted`.
- **Trust pages** — `/dpa`, `/privacy`, `/terms`, `/security` and `/subprocessors` (rendered from `compliance/subprocessors.json`, also served as JSON).
- **Pre-launch gate** — `npm run compliance:check` exits non-zero until every `operatorConfirm` field in `compliance/subprocessors.json` is confirmed, counsel sign-off is recorded in `compliance/launch-signoff.json` with the DRAFT banners removed from `landing/*.html`, and the sandbox runner is production-grade (no privileged dind without a confirmed microVM runtime class, no placeholder sandbox image). SOC 2 status is reported for information only; it is a roadmap, not a certification.
- **Known gaps** — repo clones, HNSW index files and provider-side retention are outside the retention clock. See [`docs-site/docs/compliance.md`](docs-site/docs/compliance.md) and [`soc2-roadmap.md`](docs-site/docs/soc2-roadmap.md).

---

## Dashboards

- **Built-in** — `GET /dashboard` serves a self-contained HTML page (`engine/dashboard.html`) fed by the `/events` SSE stream. No build step.
- **React dashboard** (`dashboard/`) — a separate React 19 + Vite app with pages for Login, Overview, Workflows (and workflow detail), Review Queue, DLQ, Traces, Anomalies, Tenants, and, for admins, Users and Audit log. Sign in with an API key or through OIDC SSO; controls and navigation follow the signed-in role. It is not served by `server.js`:

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
AEGIS_MODEL_BUILD=...          # optional — model for patch/test agents (default Sonnet)
AEGIS_MODEL_CHEAP=...          # optional — model for planner + review-guard (default Haiku)
AEGIS_CAP_FALLBACK=1           # 0 = refuse at the spend cap instead of downgrading to CHEAP
REDIS_URL=redis://...          # Redis Stack
DATABASE_URL=postgres://...    # optional — usage metering / billing
AEGIS_API_KEY_DEFAULT=...      # per-tenant API key(s) (prefer runtime keys: POST /tenants/:id/keys)
AEGIS_ADMIN_KEY=...            # operator key for SSO config, spend and credits routes
AEGIS_REPOS_BASE=/repos        # enables per-tenant repos (GitHub App / GitLab / Bitbucket)
AEGIS_PUBLIC_URL=...           # SSO and OAuth redirect base
AEGIS_TOKEN_ENCRYPTION_KEY=... # seals provider tokens, IdP secrets, BYOK keys (openssl rand -hex 32)
AEGIS_UNVERIFIED_CAP_USD=5     # LLM spend cap until a tenant's first paid invoice
AEGIS_TENANTS=default          # tenants registered at boot
PORT=3000
QUEUE_BACKEND=bullmq           # or sqs | redis-streams
CLAUDE_AUTONOMY=true           # false = every patch held for human review
AEGIS_SANDBOX_MODE=            # 'local' bypasses Docker (dev only, never prod)
DOCKER_HOST=tcp://...:2376     # isolated remote runner (mTLS); forces the stream transport
AEGIS_SANDBOX_IMAGE=...        # image with the lint/test toolchain (Dockerfile.sandbox)
AEGIS_MERGE_STRATEGY=rebase    # or 'flag'
AEGIS_AUDIT_SIGNING_KEY=...    # required in production
DLQ_MAX_RETRIES=2
STRIPE_SECRET_KEY=...          # optional — billing
STRIPE_WEBHOOK_SECRET=...      # optional — billing
```

Vector memory reranking, concurrency limits per priority tier, rate limits, DLQ backoff, anomaly thresholds, PR automation, GitHub App / GitLab / Bitbucket OAuth settings, SSO session length, retention, sandbox transport limits, Slack/Discord webhooks, and inbound webhook secrets are all separately tunable.

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
npm run compliance:check # pre-launch compliance gate (fails until human sign-offs are done)
npm run check          # lint + coverage
```

The unit suite (`tests/`) covers agent-runner, approval-gate, audit-log (incl. identity and zero-retention), auth routes and the billing gate, RBAC, SSO and users, billing tiers/allowance/free tier, spend guard, BYOK, plan changes, signup, Stripe reporter/webhook, pending-cleanup, pricing model, concurrency, the git engine and providers, GitHub App and per-tenant repos, language toolchains and analyzers, sandbox fail-closed and stream behaviour, the pipeline, prompt guard and prompt-eval (including adversarial cases), repo-scanner, retention and its scheduler, retry-policy, review-system, usage-recorder, vector-memory, workflow-store, and the benchmark/case-study tooling.

The system suite (`tests/integration/system/`) exercises the Docker sandbox, git worktrees, the end-to-end pipeline, and the BullMQ/Redis Streams/SQS queue backends against real infrastructure. These need a live Docker daemon and Redis (Redis Stack for FT.SEARCH-backed vector memory); the Docker sandbox tests skip themselves when Docker isn't reachable.

**CI** (`.github/workflows/ci.yml`) runs lint + unit tests with coverage, then system tests (real Redis and git), then the prompt eval gate. The eval step is skipped on fork PRs without secrets and is non-blocking if the Claude API is unreachable.

---

## Deployment

### One-click (trial / eval)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Naveenub/aegis)

`render.yaml` provisions Postgres, a Redis Stack private service, a single combined web service (server + worker + dlq-worker sharing one disk), and three crons: hourly billing flush, daily pending-signup cleanup (03:00 UTC) and daily retention sweep (03:30 UTC). You'll be prompted for `ANTHROPIC_API_KEY` during setup. Tenant code never runs on the web service: set `DOCKER_HOST` (mutual TLS), the `ca.pem`/`cert.pem`/`key.pem` Secret Files and `AEGIS_SANDBOX_IMAGE` (built from `Dockerfile.sandbox`) to point it at an isolated remote runner (see `scripts/provision-runner.sh`); without them lint/test steps are blocked and self-serve signup stays off. The worktree is streamed to the runner as a tar (no host paths, no `.git`), so only stdout comes back. This topology trades away horizontal worker scaling in exchange for a deploy with no nested Docker. Fork the repo first if you're deploying your own copy.

### Self-hosted with Docker Compose (production)

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
docker compose up -d --build
```

This starts `redis` (Redis Stack), `postgres`, `server` (port 3000), `worker`, `dlq-worker`, a rootless `dind` sidecar, and a one-shot `sandbox-image` service that builds `aegis-sandbox:local` inside dind (the worker waits for it), all from a single `node:20-alpine` image (`Dockerfile`). This stack is for local dev and single-tenant self-hosting; self-serve signup is refused here by design. Things worth knowing:

- **`worker` talks to a rootless Docker-in-Docker sidecar (`dind`), not the host socket.** `sandbox.js` shells out to `docker run` for every lint/test execution; pointing `DOCKER_HOST` at the isolated rootless daemon instead of mounting `/var/run/docker.sock` caps a sandbox compromise at that sidecar's unprivileged UID rather than the host. For a genuinely multi-tenant deployment, the next step up is a dedicated remote Docker host.
- **Paid multi-tenant use needs an isolated runner.** Set `DOCKER_HOST` (tcp with mutual TLS, or ssh) plus `DOCKER_TLS_VERIFY=1`; signup only enables when one is configured (or `AEGIS_ALLOW_UNSANDBOXED_SIGNUP=true` for demos). With `DOCKER_HOST` set, `sandbox.js` streams the worktree (minus `.git`) as a tar and `AEGIS_SANDBOX_MODE=local` / `CI=true` are ignored. `scripts/provision-runner.sh` and `scripts/sandbox-setup.sh` set up the runner and certs.
- **`server` and `worker` share a `repo` volume** so `AEGIS_REPO_ROOT`/`AEGIS_WORKTREES` resolve to the same git checkout across both processes.

### Kubernetes

Manifests under `k8s/` cover the namespace, configmap, secrets example, Redis Stack, repo PVC, server/worker/dlq-worker deployments, the `aegis-sandbox` runner (mutual TLS on port 2376), HPA, ingress, and three CronJobs (billing flush, pending-signup cleanup, retention sweep). Apply with `kubectl apply -k k8s/`. Read `k8s/README.md` first — it covers the `ReadWriteMany` storage requirement, the sandbox runner and its TLS secrets, and the single-replica server constraint.

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
```

**Status (honest):** the harness, 8 verified tasks and the case-study generator are built and tested. **No published Aegis results and no named design-partner case study exist yet**; both are produced only by running the commands above, never written by hand. Methodology and limits: [`bench/README.md`](bench/README.md), [ROI benchmark](docs-site/docs/benchmark.md), [design-partner protocol](docs-site/docs/case-studies/pilot-protocol.md).

---
## Documentation

The Docusaurus site in `docs-site/` covers the intro, quickstart, architecture, configuration, API reference, billing, deployment, testing, compliance, SOC 2 roadmap, launch checklist, and a candid [failure-modes](docs-site/docs/FAILURE_MODES.md) register. Run it locally with:

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
