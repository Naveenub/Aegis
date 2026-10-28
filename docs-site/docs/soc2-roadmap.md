---
id: soc2-roadmap
title: SOC 2 Roadmap
sidebar_position: 10
---

# SOC 2 Roadmap

Aegis is **not SOC 2 certified**. This page is the internal plan and an honest map of what the codebase already gives an auditor. The public status is on `/security`; keep the two in sync and never claim a stage before it is complete.

## Stages

| # | Stage | Output | Owner decision needed |
|---|---|---|---|
| 1 | Controls in place | Technical controls below | — done in code |
| 2 | Readiness | Auditor/compliance-platform selected, scope set (start with **Security + Confidentiality**; add Availability once SLOs exist), policies adopted, gap list closed | Pick platform (e.g. Vanta/Drata/Secureframe) and auditor; budget |
| 3 | Type I | Auditor opinion on design at a date | Choose date |
| 4 | Type II | Opinion on operating effectiveness over an observation window (3–12 months) | Window length |

Type I → Type II is usually the point at which enterprise buyers stop asking for questionnaires. Until then: security questionnaire, DPA, and control docs under NDA.

## Control map (what exists today)

| Criterion area | Control | Where |
|---|---|---|
| CC6.1 Logical access | Per-tenant API keys, SHA-256 hashed, revocable; every route checks tenant ownership | `engine/key-store.js`, `middleware/auth.js` |
| CC6.1 Encryption | Git tokens + BYOK keys AES-256-GCM at rest | `engine/token-vault.js` |
| CC6.6 Boundary | Rate limiting; mTLS-only sandbox Docker API in k8s; signup requires authenticated remote runner | `middleware/rate-limit.js`, `k8s/06a-sandbox.yaml` |
| CC6.7 Data in transit | TLS at ingress / host (operator-configured — **not enforced in manifests**) | `k8s/09-ingress.yaml` |
| CC7.2 Monitoring | Prometheus/OTEL metrics, anomaly detector, alert rules | `engine/metrics.js`, `monitoring/` |
| CC7.2 / CC4 Audit trail | Tamper-evident HMAC hash-chain audit log, exportable, verifiable | `engine/audit-log.js` |
| CC8.1 Change management | CI (lint + tests) on every change | `.github/workflows/ci.yml` |
| C1.1–C1.2 Confidentiality | Configurable retention, zero-retention mode, content deletion | `engine/retention*.js` |
| P / privacy | Privacy policy, DPA, subprocessor list | `landing/`, `compliance/` |
| Human oversight | Approval gate before patches apply | `engine/approval-gate.js` |
| A1 Availability | Queue retries, DLQ, health check, HPA | `engine/retry-policy.js`, `k8s/08-hpa.yaml` |

## Gaps an auditor will raise

These are mostly **organisational**, not code:

1. **Policies**: information security, access control, incident response, change management, vendor management, data classification, BCP/DR, acceptable use. None are written.
2. **Evidence collection**: access reviews, onboarding/offboarding checklists, background checks, security training, laptop/MDM controls.
3. **Production access**: SSO + MFA for GitHub, Render/k8s, Stripe, Anthropic and OpenAI consoles; documented least-privilege; break-glass process.
4. **Change management**: branch protection with required review (CI exists; confirm reviews are enforced).
5. **Backups and restore tests**: Redis/Postgres backup policy and a tested restore.
6. **Vulnerability management**: dependency scanning (`npm audit`/Dependabot), container scanning, periodic third-party pen test.
7. **Incident response**: runbook, on-call, the 72-hour customer notification the DPA promises.
8. **Vendor reviews**: collect SOC 2 reports from Anthropic, OpenAI, Stripe, host.
9. **Encryption at rest of Redis**: relies on the host; confirm and document.
10. **Audit log signing key**: `AEGIS_AUDIT_SIGNING_KEY` rotation policy (the module says never rotate without re-signing history).
11. **TLS enforcement**: add TLS to the ingress manifest or document the managed equivalent.
12. **Repo clones** are outside the retention clock (see Compliance → Known gaps).

## Suggested order

1. Pick the platform and auditor; set scope. 2. Write the eight policies (platforms ship templates). 3. Turn on SSO/MFA everywhere and add branch protection. 4. Dependency + container scanning in CI. 5. Backup/restore test. 6. Readiness assessment → close gaps → Type I date → start the Type II window.
