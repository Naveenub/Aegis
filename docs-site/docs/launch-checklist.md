---
title: Compliance launch checklist
---

# Compliance launch checklist

Run `npm run compliance:check` — it exits non-zero until the items below are done.

| Item | Who | How |
| --- | --- | --- |
| Retention enforcement | Engineering | Deploy `k8s/12-retention-sweep-cronjob.yaml` / Render cron `aegis-retention-sweep`. The API server also runs the same sweep daily as a Redis-locked safety net (`AEGIS_RETENTION_INPROCESS=off` to disable). Verify with `npm run retention:sweep -- --dry-run`. |
| Subprocessor facts | Operator | For each `operatorConfirm` field in `compliance/subprocessors.json` (Anthropic and OpenAI provider retention; hosting location and provider retention), verify against your real contracts and add `"confirmed": { "<field>": "<date, source, who>" }` to that entry. Update `lastUpdated` and give customers 30 days' notice for any change. |
| Counsel review | Legal | Counsel reviews `/dpa`, `/privacy`, `/security`, `/terms`. Then remove the "DRAFT" banners from `landing/*.html` and set `counselReviewedAt` / `reviewedBy` in `compliance/launch-signoff.json`. |
| SOC 2 | Company | Roadmap only: see [SOC 2 roadmap](./soc2-roadmap.md). Do not claim certification until an auditor's report exists. |
