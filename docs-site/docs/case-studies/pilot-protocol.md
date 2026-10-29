---
id: pilot-protocol
title: Design-partner pilot protocol
---

# Design-partner pilot protocol

A case study is only credible if the numbers come from the partner's own repo and their engineers' decisions. This protocol makes that cheap to collect. **There is no published case study yet**; this is how to get one.

## Before the pilot (agree in writing)

1. **Scope**: one repo, one team, 4–8 weeks, ≥ 15 real tickets of the kind Aegis should handle (bugs, small features, test gaps).
2. **Baseline**: how "time without Aegis" is established. Best: the team times 5–10 comparable past tickets. Otherwise ticket cycle-time history. Write the method down; it goes in the study.
3. **Consent**: whether they may be named, whether a quote may be used, and who approves the final text. Record `approvedBy` and `approvedAt`. Without them the generator refuses to name them.
4. **Mode**: run with `CLAUDE_AUTONOMY=false` or PR-only (`AEGIS_PR_PROVIDER`) so every change is reviewed by a human. Never auto-merge to their main branch.
5. **Data handling**: confirm the DPA/subprocessor terms before connecting a private repo (`npm run compliance:check`).

## During

Onboard with `npm run onboard -- <tenantId> "<Partner>"`. For each PR Aegis opens, the reviewer records, in a shared sheet: outcome (merged / merged after edits / closed / still open), minutes spent reviewing, minutes spent fixing up, and what the ticket would have taken without Aegis.

Do not drop closed PRs or tickets Aegis failed on. They are the denominator.

## After

```bash
npm run case-study -- export <tenantId> --out ledger.json   # cost + wall time from Aegis metering
# fill in prUrl / outcome / review / fix-up / baseline per PR, and write partner.json
npm run case-study -- render ledger.json partner.json --out study.md
```

`partner.json` template: `bench/templates/partner.example.json`.

The generator prints **DRAFT — NOT FOR PUBLICATION** unless the partner has consented to being named, there are at least 10 decided PRs, and time saved was measured on at least one PR. It prints "not measured" for anything missing rather than estimating.

## What the study will report

PRs merged by the partner's engineers (with confidence interval), cost per merged PR including closed PRs, net engineer time saved, and a ledger linking every PR so a reader can check it.
