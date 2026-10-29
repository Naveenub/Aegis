---
id: benchmark
title: ROI benchmark
sidebar_position: 8
---

# ROI benchmark

`npm run eval` only scores whether agent personas follow their output format. The ROI benchmark (`bench/`) measures outcomes on real repos:

- **Verified merge rate**: merged by Aegis *and* passing held-out tests from the original PR
- **Cost per merged PR**: all LLM spend, failures included
- **Time saved**: net of failed attempts and review time, only where human time was actually recorded

```bash
npm run bench:verify    # tasks are valid problems (no LLM)
npm run bench:selftest  # harness check with a known-good patch (no LLM, synthetic)
npm run bench           # real run: needs ANTHROPIC_API_KEY, Redis Stack, Docker
npm run bench:report -- bench/results/<runId>
```

**Current status:** harness and 8 verified tasks (4 repos) are in place. No published Aegis results yet. This page will link the first report once a run exists. Methodology, limits and how to record human time: [`bench/README.md`](https://github.com/Naveenub/aegis/blob/main/bench/README.md).

For results on a private product codebase, see the [design-partner protocol](./case-studies/pilot-protocol.md).
