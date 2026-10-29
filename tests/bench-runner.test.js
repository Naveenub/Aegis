/**
 * Harness plumbing test: a real local git repo, a real task layout, the oracle
 * engine (gold patch, no LLM). Proves checkout → merge detection → held-out
 * validation → record, including the failure paths that must NOT count as
 * accepted. No network, no Redis, no API key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { runBenchmark } from '../bench/run.js';
import { oracleEngine } from '../bench/lib/engines.js';
import { loadResults, renderReport } from '../bench/report.js';

const sh = (args, cwd, input) => execFileSync('git', args, { cwd, encoding: 'utf-8', input });
let tmp; let origin; let baseSha;

// A repo whose "test" is `node check.js`: exits 1 until add() is fixed.
const BUGGY = 'exports.add = (a, b) => a - b;\n';
const FIXED = 'exports.add = (a, b) => a + b;\n';
const CHECK = "const {add}=require('./lib.js'); process.exit(add(2,3)===5?0:1);\n";

function makeTask(name, { goldContent = FIXED } = {}) {
  const dir = path.join(tmp, 'tasks', name);
  fs.mkdirSync(dir, { recursive: true });
  // Build patches from a scratch clone so they are byte-exact git diffs.
  const scratch = path.join(tmp, `scratch-${name}`);
  fs.mkdirSync(scratch);
  sh(['init', '-q', '-b', 'main'], scratch);
  sh(['config', 'user.email', 't@t'], scratch); sh(['config', 'user.name', 't'], scratch);
  fs.writeFileSync(path.join(scratch, 'lib.js'), BUGGY);
  sh(['add', '.'], scratch); sh(['commit', '-qm', 'base'], scratch);
  fs.writeFileSync(path.join(scratch, 'check.js'), CHECK);
  sh(['add', '-N', 'check.js'], scratch);
  fs.writeFileSync(path.join(dir, 'test.patch'), sh(['diff'], scratch));
  sh(['reset', '-q'], scratch); fs.rmSync(path.join(scratch, 'check.js'));
  fs.writeFileSync(path.join(scratch, 'lib.js'), goldContent);
  fs.writeFileSync(path.join(dir, 'gold.patch'), sh(['diff'], scratch));
  return {
    id: name, repo: 'local/fixture', baseSha, dir, language: 'javascript', setup: [],
    prompt: 'add() subtracts instead of adding; fix it.', fail_to_pass: 'node check.js',
    baseline: { minutes: null, source: null },
  };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-bench-test-'));
  origin = path.join(tmp, 'origin');
  fs.mkdirSync(origin);
  sh(['init', '-q', '-b', 'main'], origin);
  sh(['config', 'user.email', 't@t'], origin); sh(['config', 'user.name', 't'], origin);
  fs.writeFileSync(path.join(origin, 'lib.js'), BUGGY);
  sh(['add', '.'], origin); sh(['commit', '-qm', 'base'], origin);
  baseSha = sh(['rev-parse', 'HEAD'], origin).trim();
  sh(['config', 'uploadpack.allowAnySHA1InWant', 'true'], origin);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('runBenchmark (oracle engine)', () => {
  it('accepts a correct patch and rejects merged-but-wrong and not-merged outcomes', async () => {
    const good = makeTask('good');
    const wrong = makeTask('wrong', { goldContent: 'exports.add = (a, b) => a * b;\n' }); // merges, fails held-out test
    const never = makeTask('never');
    const noop = { name: 'noop', synthetic: true, execute: async () => ({ status: 'failed', costUsd: 0.5, tokensIn: 10, tokensOut: 5 }) };

    const out = path.join(tmp, 'out');
    const run = (tasks, engine, sub) => runBenchmark({
      tasks, engine, outDir: path.join(out, sub), workRoot: path.join(tmp, 'work', sub),
      remoteFor: () => `file://${origin}`, log: () => {},
    });

    const [g] = await run([good], oracleEngine(), 'good');
    expect(g.outcome).toBe('accepted');
    expect(g.filesChanged).toBe(1);
    expect(g.costUsd).toBe(0);

    const [w] = await run([wrong], oracleEngine(), 'wrong');
    expect(w.outcome).toBe('merged_bad');
    expect(w.validation.find((v) => v.label === 'fail_to_pass').ok).toBe(false);

    const [n] = await run([never], noop, 'never');
    expect(n.outcome).toBe('not_merged');
    expect(n.costUsd).toBe(0.5);

    // Report round-trips from disk and flags the synthetic run.
    const { markdown } = renderReport(loadResults(path.join(out, 'good')));
    expect(markdown).toMatch(/SYNTHETIC RUN/);
    expect(markdown).toMatch(/1\/1 = 100%/);
  }, 60_000);

  it('records an engine infra error without scoring it as a failure', async () => {
    const t = makeTask('infra');
    const boom = { name: 'boom', synthetic: true, execute: async () => ({ status: 'infra_error', error: 'credit balance is too low', costUsd: 0 }) };
    const [r] = await runBenchmark({
      tasks: [t], engine: boom, outDir: path.join(tmp, 'out', 'infra'), workRoot: path.join(tmp, 'work', 'infra'),
      remoteFor: () => `file://${origin}`, log: () => {},
    });
    expect(r.outcome).toBe('infra_error');
  }, 30_000);
});
