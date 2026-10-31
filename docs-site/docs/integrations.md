---
id: integrations
title: Inbound triggers
---

Besides REST, the CLI and SCM push webhooks, Aegis starts workflows from a GitHub issue label, Slack, and Jira. Every trigger runs the same gates as `POST /task` (active billing status, quotas) and fences ticket text as untrusted data.

## GitHub issue label (GitHub App)

1. Create the app from `deploy/github-app-manifest.json` (replace `YOUR_HOST`). Permissions: Contents RW, Pull requests RW, Issues RW, Metadata R. Event: Issues.
2. Set the `AEGIS_GITHUB_APP_*` variables; connect a repo via `POST /tenants/:id/repo/connect`.
3. Add the `aegis` label to an issue in the connected repo. Aegis comments on the issue when it starts and when it finishes (with the PR link).

Existing installs must accept the new **Issues: write** permission, otherwise the status comment is skipped (the run still happens).
Change the label: `PUT /tenants/:id/triggers {"githubLabel":"ai-fix"}`.

## Slack

1. Create the app from `deploy/slack-app-manifest.yml`; set `AEGIS_SLACK_SIGNING_SECRET`.
2. `POST /tenants/:id/triggers/slack/link-code` → in Slack run `/aegis link <code>` (codes last 15 min, single use; a workspace links to one tenant).
3. `/aegis fix the flaky login test` starts a workflow. Restrict who can run it: `PUT /tenants/:id/triggers {"slackAllowedUsers":["U012ABC"]}`.

Replies use Slack's `response_url` (valid ~30 min); later completion messages after that window use `AEGIS_SLACK_WEBHOOK` if set.

## Jira

1. `POST /tenants/:id/triggers/jira/secret` → `{ secret, url }` (shown once).
2. Either register a Jira webhook (`jira:issue_created`, `jira:issue_updated`) at `url` with that secret (`X-Hub-Signature`), or use a Jira Automation rule "Send web request" to `url` with header `X-Aegis-Token: <secret>` and body `{"issueKey":"{{issue.key}}","summary":"{{issue.summary}}","description":"{{issue.description}}","labels":["aegis"]}`.
3. Adding the `aegis` label (or creating a ticket with it) starts a workflow. Limit projects: `PUT /tenants/:id/triggers {"jiraProjects":["APP"]}`.

Jira write-back is not implemented; follow progress in the dashboard or the PR.

## Config reference

| Variable | Purpose |
| --- | --- |
| `AEGIS_SLACK_SIGNING_SECRET` | Verifies `/aegis` requests (fails closed when unset) |
| `AEGIS_TRIGGER_LABEL` | Default label for GitHub and Jira (default `aegis`) |
| `AEGIS_PUBLIC_URL` | Base URL used in the Jira URL returned by the secret endpoint |

## Marketplace

See `marketplace/listing.md` for the GitHub Marketplace listing copy and submission requirements.
