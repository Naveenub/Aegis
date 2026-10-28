---
id: compliance
title: Compliance & Data Retention
sidebar_position: 9
---

# Compliance & Data Retention

What Aegis stores, for how long, and how a customer controls it. The customer-facing versions live at `/privacy`, `/dpa`, `/subprocessors` and `/security` (source: `landing/`). **All legal text is a DRAFT until counsel has reviewed it.**

## Where customer content lives

| Store | Holds | Retention |
|---|---|---|
| Redis `aegis:job:*` | Job status, timing, short `result` text | `jobsDays` (default 90) |
| Redis `aegis:workflow:*`, `aegis:trace:*`, `aegis:review:*`, `aegis:rewind:*` | Step descriptions, patches, test output, review notes | `workflowsDays` after the workflow finishes (default 90) |
| Redis `aegis:memory:*` (+ HNSW index on disk) | Past task text, patches, embeddings | `memoryDays` (default 30) |
| Redis `aegis:audit:*` | Actor, action, resource ids, 500-char task excerpt | Life of the account — not prunable (hash chain) |
| Postgres `usage_events` | Counts only (runs, steps, tokens, minutes) | Billing records |
| Tenant repo clone + worktrees on the repo volume | The customer's code | Until `DELETE /tenants/:id/repo` |

## Configuring retention

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"jobsDays":30,"workflowsDays":14,"memoryDays":7}' \
  $AEGIS/tenants/acme/retention
# null resets a field to the platform default; GET returns the effective policy.
```

Platform defaults: `AEGIS_RETENTION_JOBS_DAYS`, `AEGIS_RETENTION_WORKFLOWS_DAYS`, `AEGIS_MEMORY_TTL_DAYS`. Range is 1–365 days.

**Enforcement is a scheduled job.** Run `npm run retention:sweep` daily (k8s: `12-retention-sweep-cronjob.yaml`; Render: `aegis-retention-sweep`). Only *finished* workflows (completed, failed, cancelled) are purged; running and paused ones are never touched. `--dry-run` reports counts without deleting; `--tenant=<id>` limits the run. Memory is additionally evicted hourly by the in-process cron using each tenant's policy. Policy changes take effect in other processes within ~15 s (per-process cache).

## Zero-retention mode

```bash
curl -X PUT -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"zeroRetention":true}' $AEGIS/tenants/acme/retention
```

| Surface | Behaviour |
|---|---|
| Vector memory | Not written, not read, existing entries purged. Nothing is sent to the embeddings provider. |
| Job `result` | Redacted at write time, except fixed status phrases (`success`, `No patch generated`, …). |
| Audit log | Kept; the 500-char `detail.task` excerpt is replaced with a redaction marker. |
| Workflow records | When a workflow reaches a terminal state: step descriptions, errors, patches, traces, review records and rewind history are removed. Ids, statuses and timestamps remain so status polling and billing still work. The sweeper re-scrubs anything the hook missed. |
| While a workflow runs | Content **is** held in Redis — execution and retries need it. |
| LLM provider | **Unchanged.** Anthropic's retention is set by Aegis's agreement with Anthropic. Zero-retention at Aegis does not make the provider zero-retention. |

Enabling it runs a sweep for that tenant immediately.

Approval mode (`CLAUDE_AUTONOMY=false`) keeps a workflow non-terminal while a patch waits for review, so its content is held until the review is resolved.

## Deleting content on request

`POST /tenants/:id/data-deletion` with `{"confirm":"<tenantId>"}` removes finished-workflow, job and memory content for that tenant and writes a `data.deleted` audit event. Active workflows are skipped and counted in `skippedActive` — cancel them and call again. It does **not** remove the audit log, billing records, API-key records, Stripe customer or the repo clone; account closure is a separate operator task.

## Known gaps (be upfront with customers)

- **HNSW index files** keep embedding vectors of evicted memories until the index is rebuilt. Vectors are not reversible to text, but are derived from it. Zero-retention tenants never write new ones.
- **Repo clones** are kept on the repo volume until the tenant disconnects; they are not on the retention clock.
- **Backups** by the hosting provider age out on its schedule.
- **Running workflows** that are cancelled after content was written rely on the sweeper for any late writes.
- **Provider-side retention** (Anthropic, OpenAI) is outside Aegis's control.
- The audit log can't be pruned, so the 500-char task excerpt (non-zero-retention tenants) lives as long as the account.

## Before launch checklist

1. Counsel reviews `privacy.html`, `dpa.html`, `security.html`, and `terms.html` is updated to incorporate the DPA by reference.
2. Confirm every `operatorConfirm` field in `compliance/subprocessors.json` (Anthropic/OpenAI retention terms, hosting region) against real contracts and deployment; update `lastUpdated`.
3. Decide whether to obtain zero data retention from Anthropic; if so, say so on the subprocessor page.
4. Sign DPAs with Anthropic, OpenAI (if vector memory is on), Stripe and the host.
5. Deploy the retention cron and confirm its first run in logs.
6. Set `AEGIS_CONTACT_EMAIL`; set up a mailbox for DPA, deletion and vulnerability reports.
7. Decide how subprocessor-change notices are emailed (the pages promise 30 days).
