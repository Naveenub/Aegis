# Aegis ROI benchmark

The prompt eval (`npm run eval`) checks that each agent persona answers in the right *format*. It says nothing about whether Aegis produces PRs a maintainer would merge, or what they cost. This benchmark does.

**Status: harness built and self-tested; no published Aegis results yet.** Numbers appear in `bench/results/` only after a real run (`--engine aegis`) and are never written by hand. See "Publishing results".

## What it measures

Each task is a real, already-merged change from a public repo (2026 merges, to limit training-data contamination), turned into a problem:

- Aegis gets only `prompt` (an issue-style description) and the repo at the parent commit.
- Afterwards, tests Aegis never saw (`test.patch`, the PR's own tests) are applied to what Aegis merged.

| Metric | Definition |
|---|---|
| **Verified merge rate** | merged **and** held-out tests pass ÷ tasks attempted. Headline number. Reported with a 95% Wilson interval. |
| Merge rate | Aegis's branch actually moved past the base commit (checked in git, not from engine status). A patch that merges but fails the held-out tests is a liability, so it is shown separately. |
| **Cost per merged PR** | *all* LLM spend (planner re-plans, retries, failed tasks) ÷ merged PRs. From the engine's own cost counter. |
| **Time saved** | Per task with both inputs: merged → `baseline − review − fix-up`; not merged → `−review`. Reported with coverage (n of N). Never extrapolated. Needs human data (below). |
| Net value | Only if you pass `--hourly-usd`; labelled as an assumption. |

Infrastructure errors (API outage, billing, harness crash) are excluded from rates and counted separately, so an outage is not scored as an Aegis failure.

## Run it

```bash
# 1. Prove each task is a valid problem (no LLM): fails without the fix, passes with it
node bench/verify-tasks.js [--docker node:22]

# 2. Prove the harness works (no LLM, no key): applies each task's known-good patch.
#    Expect 8/8 accepted, $0. Stamped SYNTHETIC; never quote it.
node bench/run.js --engine oracle

# 3. The real run. Needs ANTHROPIC_API_KEY, Redis Stack at REDIS_URL, Docker.
#    Use a DEDICATED Redis: cost is the delta of the engine's global counter.
node bench/run.js --engine aegis [--docker python:3.12] [--id <task>]...

# 4. Report
node bench/report.js bench/results/<runId> [--hourly-usd 120]
```

Task commands run third-party test code: use a disposable VM/container.

## Human time (for "time saved")

Time saved cannot be measured by a script. Create `bench/results/<runId>/annotations.json`:

```json
{ "click-sentinel-copy-pickle-3805": { "reviewMinutes": 9, "fixupMinutes": 0,
                                       "baselineMinutes": 45 } }
```

- `reviewMinutes`: a reviewer's timed read of the Aegis patch (do it blind to whether it passed).
- `baselineMinutes`: how long a comparable engineer takes unassisted. Record how you got it (timed study, ticket history) in the report you publish. `baseline.minutes` in `task.json` can hold it too, with a required `source`.

Without both, the report says "Not measured".

## Task set

8 tasks, 4 repos (attrs, click, marshmallow, express). Known limits:

- Small sample: expect wide intervals. Add tasks before drawing conclusions.
- Mostly Python; one JS. Add Go/Java/TS tasks to cover the rest of the toolchains.
- Prompts were written from commit messages and diffs, not original issue text; none of the tasks link an issue. PR numbers for the two click tasks come from changelog entries and were not checked against GitHub.
- Tasks that depend on unpinned `pytest` may drift; pin versions when re-verifying.
- Public repos can't be fully ruled out as seen-in-training.
- The suite is OSS libraries. It does not show how Aegis does on a private product codebase. That is what the design-partner case study is for (`docs-site/docs/case-studies/`).

## Publishing results

1. Run `verify-tasks`, then `--engine aegis` on a clean checkout; keep `results.jsonl`, `meta.json`, `report.md`, `summary.json` together (commit them under `bench/results/<runId>/`).
2. Quote the verified merge rate **with its interval and n**, the model names from `meta.json`, and the Aegis commit.
3. If any of Aegis's own numbers change after a persona/prompt change, rerun. Do not mix runs.
