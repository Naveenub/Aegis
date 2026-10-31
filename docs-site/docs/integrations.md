---
id: integrations
title: Inbound triggers
---

Besides REST, the CLI and SCM push webhooks, Aegis starts workflows from a GitHub issue label, Slack, and Jira. Every trigger runs the same gates as `POST /task` (active billing status, quotas) and fences ticket text as untrusted data.

## GitHub issue label (GitHub App)

1. Create the app from `deploy/github-app-manifest.json` (replace `YOUR_HOST`). Permissions: Contents RW, Pull requests RW, Issues RW, Metadata R. Event: Issues.
2. Set the `AEGIS_GITHUB_APP_*` variables; connect a repo via `POST /tenants/:id/repo/connect`.
3. Add the `aegis` label to an issue in the connected repo. Aegis comments on the issue when it starts and when it finishes (with the PR link).

Existing installs must accept the new **Issues: write** permission (a GitHub-side approval Aegis cannot grant). Until then the run still happens, the comment is skipped, and `GET /tenants/:id/triggers` shows `lastOriginProblem` so it is visible rather than silent.
Change the label: `PUT /tenants/:id/triggers {"githubLabel":"ai-fix"}`.

## Slack

1. Create the app from `deploy/slack-app-manifest.yml`; set `AEGIS_SLACK_SIGNING_SECRET`.
2. `POST /tenants/:id/triggers/slack/link-code` → in Slack run `/aegis link <code>` (codes last 15 min, single use; a workspace links to one tenant).
3. `/aegis fix the flaky login test` starts a workflow. Restrict who can run it: `PUT /tenants/:id/triggers {"slackAllowedUsers":["U012ABC"]}`.

**Replies.** Without OAuth, replies use Slack's `response_url` (valid ~30 min). For completion messages at any time, install via OAuth instead: set `AEGIS_SLACK_CLIENT_ID`, `AEGIS_SLACK_CLIENT_SECRET`, `AEGIS_PUBLIC_URL`, add `${AEGIS_PUBLIC_URL}/slack/oauth/callback` as the Slack app's redirect URL, then open the URL from `GET /tenants/:id/triggers/slack/install`. This binds the workspace using the team ID Slack returns (so no link code is needed) and stores a sealed bot token; completion goes to the channel via `chat.postMessage` (scopes `commands`, `chat:write`, `chat:write.public`).

## Jira

1. `POST /tenants/:id/triggers/jira/secret` → `{ secret, url }` (shown once).
2. Aegis accepts both authentication styles, so use whichever your Jira offers: a webhook registered at `url` with that secret (`X-Hub-Signature: sha256=…`, events `jira:issue_created` and `jira:issue_updated`), or a Jira Automation rule "Send web request" to `url` with header `X-Aegis-Token: <secret>` and body `{"issueKey":"{{issue.key}}","summary":"{{issue.summary}}","description":"{{issue.description}}","labels":["aegis"]}`.
3. Adding the `aegis` label (or creating a ticket with it) starts a workflow. Limit projects: `PUT /tenants/:id/triggers {"jiraProjects":["APP"]}`.

**Write-back.** `PUT /tenants/:id/triggers/jira/credentials {"baseUrl":"https://acme.atlassian.net","email":"…","apiToken":"…"}` lets Aegis comment on the ticket when a run starts and finishes. Credentials are sealed per tenant. `baseUrl` must be `*.atlassian.net` (or a host in `AEGIS_JIRA_ALLOWED_HOSTS` for self-hosted) — it is never taken from the webhook payload.

## Config reference

| Variable | Purpose |
| --- | --- |
| `AEGIS_SLACK_SIGNING_SECRET` | Verifies `/aegis` requests (fails closed when unset) |
| `AEGIS_TRIGGER_LABEL` | Default label for GitHub and Jira (default `aegis`) |
| `AEGIS_PUBLIC_URL` | Base URL for the Jira URL and the Slack OAuth redirect |
| `AEGIS_SLACK_CLIENT_ID` / `AEGIS_SLACK_CLIENT_SECRET` | Slack OAuth install (verified binding, replies after 30 min) |
| `AEGIS_JIRA_ALLOWED_HOSTS` | Extra Jira hosts allowed for write-back (self-hosted) |
| `AEGIS_GITHUB_MARKETPLACE_WEBHOOK_SECRET` | Verifies Marketplace purchase webhooks (fails closed when unset) |
| `AEGIS_GITHUB_MARKETPLACE_PLANS` | JSON map of Marketplace plan name → Aegis tier |

## Marketplace

See `marketplace/listing.md` for the listing copy and submission requirements.

Purchases: set the listing's webhook URL to `https://YOUR_HOST/webhooks/github-marketplace` with `AEGIS_GITHUB_MARKETPLACE_WEBHOOK_SECRET`, and map plan names in `AEGIS_GITHUB_MARKETPLACE_PLANS`. `purchased`/`changed` set the tenant's tier and activate it; `cancelled` moves it to the free tier. The purchasing account is matched to the tenant that installed the App on it, so the customer must install the App and connect a repo first; otherwise the event is logged and can be redelivered from the listing's webhook page.
