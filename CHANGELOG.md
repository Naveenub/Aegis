# Changelog


## Unreleased

- **Python, Go and Java repos now run through the pipeline** — lint/test were hard-wired to ESLint + Vitest in `node:22-alpine` and the repo scanner only parsed JavaScript (acorn), so non-JS repos could not be linted, tested or given code context. New `engine/toolchains.js` detects the language(s) from marker files and picks the image, lint and test commands: Python (pytest, else unittest; ruff, else a syntax check), Go (`gofmt` + `go vet` + `go test`), Java (Maven `test-compile`/`test`, or Gradle). Scoped-then-full test passes work per language, and a polyglot repo runs every detected toolchain. The host `node_modules` is mounted and required only for the node toolchain. `engine/analyzers/` adds dependency-free Python/Go/Java scanners producing the same symbols, import graph and call graph. Sandbox runs take per-run image/env/deps/limits, and images are pulled before the run so a first pull no longer eats the timeout. Because the sandbox has no network, dependencies are installed beforehand by `engine/deps-cache.js`: once per set of manifests, in a separate network-enabled container that sees only a scratch copy of the repo (all capabilities dropped, runs as nobody), then mounted read-only into lint/test runs. Python gets `pytest` plus the repo's requirements, Go runs `go mod download` (skipped when `vendor/` is committed), and Maven/Gradle resolve plugins and dependencies. Disable with `AEGIS_SANDBOX_AUTO_DEPS=off`; supply caches by hand with `AEGIS_SANDBOX_PYTHON_DEPS` / `_GO_DEPS` / `_JAVA_DEPS`; image overrides are `AEGIS_SANDBOX_IMAGE_PYTHON` / `_GO` / `_MAVEN` / `_GRADLE`. ruff is used only when the repo configures it. Maven `target/` and Gradle `build/` are added to the repo's `info/exclude` so they aren't swept into agent commits. A worktree with no supported language now **fails** lint/tests (as it did before, when ESLint found no files) instead of passing unverified; `AEGIS_SANDBOX_ALLOW_UNSUPPORTED=true` skips instead.
- **Hardening** — file paths passed to ESLint are now shell-quoted. The scanner's extension-less import resolution no longer silently does nothing on Node 20.
- **Tenant base branch stays in sync with the default branch** — `aegis-tenant/<id>` was created from the default branch once and never updated, so upstream commits never reached new workflows and surfaced later as merge conflicts. The base branch now merges the default-branch tip before a new workflow branches from it and before each workflow merge (fast-forward when possible). A conflicting sync is aborted and leaves the base unchanged (logged, never blocks a workflow). Set `AEGIS_BASE_SYNC=off` to disable.
- **Disconnect clarifies GitHub App state** — `DELETE /tenants/:id/repo` now returns `200 { status, provider, note? }` instead of an empty `204`. For GitHub tenants the response says the App remains installed and that only the customer can uninstall it on GitHub.
- **GitLab and Bitbucket per-tenant auth** — in multi-repo mode (`AEGIS_REPOS_BASE`) a tenant can now connect a GitLab or Bitbucket Cloud repo, not just GitHub. `POST /tenants/:id/repo/connect` takes `{ "provider": "github" | "gitlab" | "bitbucket" }` (default `github`) and the browser returns to the new `/gitlab/callback` or `/bitbucket/callback`. Tokens come from OAuth 2.0, are stored AES-256-GCM encrypted (`AEGIS_TOKEN_ENCRYPTION_KEY`) and refreshed on demand under a lock (GitLab rotates refresh tokens). A revoked grant is detected at the next refresh and marks the repo `revoked`. Clone, push and PR/MR creation use the tenant's own credential; MR/PR creation now returns the already-open MR/PR instead of failing when the branch was pushed before. GitLab subgroups (`group/sub/project`) are supported. New env: `AEGIS_TOKEN_ENCRYPTION_KEY`, `AEGIS_PUBLIC_URL`, `AEGIS_GITLAB_OAUTH_CLIENT_ID/_SECRET`, `AEGIS_GITLAB_REDIRECT_URI`, `AEGIS_GITLAB_WEB_URL`, `AEGIS_BITBUCKET_OAUTH_CLIENT_ID/_SECRET`, `AEGIS_BITBUCKET_REDIRECT_URI`, `AEGIS_BITBUCKET_WEB_URL`.
- **Self-serve signup page** — `/get-started` (`landing/signup.html`) calls `POST /signup`, shows the API key once, and confirms the first payment with Stripe.js (Payment Element, including redirect-return handling). New `GET /signup/config` serves the publishable key from `STRIPE_PUBLISHABLE_KEY`. The server now serves the landing page at `/`, and the Starter/Pro pricing buttons link to the signup page instead of a mailto.

## v2.0.0

Major release. This snapshot summarizes AEGIS as it stands today — a Git-backed, DAG-driven multi-agent orchestration engine.

### Highlights

- **DAG-based planning** — LLM-produced JSON plans validated for cycles (Kahn's algorithm), forward references, and agent-name correctness before execution.
- **Seven specialized agents** — `feature-builder`, `debugger`, `refactorer`, `test-writer`, `security-editor`, `review-guard`, and `meta-reviewer` (retry fallback).
- **Docker-sandboxed execution** — every lint/test run happens in an isolated container by default; explicit opt-out only via `AEGIS_SANDBOX_MODE=local`, `AEGIS_SANDBOX_DISABLE=true`, or `CI=true`.
- **Git-based rollback and step rewind** — per-workflow worktrees/branches, `rollbackLastCommit`/`revertStepCommit`, rebase-and-retry merge strategy, and a `POST /steps/:stepId/rewind` endpoint with full audit trail.
- **Multi-tenancy** — per-tenant API keys, quotas, and isolated worktrees/queues.
- **Human-in-the-loop approvals** — `CLAUDE_AUTONOMY=false` or per-step `requiresApproval`, resolved via `/review-queue`.
- **Vector memory** — Redis Stack (FT.SEARCH) hybrid cosine + BM25 + recency reranking with per-tenant adaptive weights; degrades gracefully without `OPENAI_API_KEY`.
- **Dead letter queue** — exponential backoff, staleness sweeps, webhook alerts.
- **Anomaly detection** — success rate, p95 latency, latency spikes, and retry rate monitored on a fixed interval.
- **Metrics** — Prometheus text export (`/metrics`) and OTEL-compatible JSON (`/metrics/json`).
- **Inbound webhooks + PR/MR automation** — signature-verified GitHub/GitLab triggers; auto-opens PRs/MRs on `github`/`gitlab`/`bitbucket` after merge.
- **SSE dashboard and live event stream** (`/dashboard`, `/events`).
- **AST-based repo intelligence** via `acorn`-built symbol tables and import/call graphs.
- **CLI** (`cli/claude.js`) for submitting tasks and polling to completion.
- **Kubernetes manifests** under `k8s/` for namespace, Redis, PVC, server/worker/dlq-worker deployments, HPA, and ingress.

### Known limitations

- `npm run test:system` requires a live Docker daemon and Redis Stack; it won't run in sandboxed/CI environments without those.
- The local-HNSW vector memory fallback (plain Redis, no Stack) is single-process only and desyncs memory across a multi-container deployment. `initVectorIndex()` now fails fast with a descriptive error in that case unless `AEGIS_ALLOW_HNSW_FALLBACK=true` is explicitly set (single-process/dev only) — see `engine/vector-memory.js`.

---

_Earlier version history is not tracked in this changelog; this entry establishes the baseline going forward._
