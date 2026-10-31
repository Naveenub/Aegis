# GitHub Marketplace listing — Aegis (copy into the listing form)

**Listing name:** Aegis
**Category:** Code quality / Continuous integration (pick the closest offered)
**Pricing plan (initial):** Free listing; paid plans are blocked until the owning org is a verified publisher and the app has ≥100 installations.

**Introductory description**
Label an issue `aegis` and get a tested pull request.

**Detailed description**
Aegis plans the fix with a multi-agent workflow, writes the change in an isolated git worktree, runs your lint and tests in a sandbox, and opens a pull request. Every run is gated by a review step and an audit trail.

- Trigger: add the `aegis` label to an issue (label name configurable per tenant)
- Scope: the single repository you select; short-lived installation tokens, nothing long-lived stored
- Permissions: Contents RW (push branch), Pull requests RW (open PR), Issues RW (status comment), Metadata R
- Also available: Slack `/aegis`, Jira label trigger, REST API, CLI

**Required before submitting (GitHub requirements)**
1. App is public and owned by an organization (org owner submits; App Manager role cannot).
2. Valid publisher contact info; logo, feature card, screenshots; description free of errors.
3. App webhook URL live: `https://YOUR_HOST/webhooks/github-app`.
4. Accept the GitHub Marketplace Developer Agreement.
5. Paid plans only: verified publisher + ≥100 installations + handle `marketplace_purchase` events (not implemented yet).

**URLs to fill in**
- Support / privacy / terms: publish `landing/privacy.html`, `landing/terms.html`, `landing/security.html` at public URLs
- Installation URL: `https://github.com/apps/<slug>/installations/new`
