/**
 * tests/prompt-eval.test.js
 *
 * Unit tests for engine/prompt-eval.js
 *
 * Covers:
 *   scoreResponse()   — per-agent structural + quality scoring
 *   evalAgent()       — dryRun mode using STUB_RESPONSES
 *   evalAll()         — dryRun over all agents
 *   recordEvalResult()— writes a JSONL line without throwing
 *   readEvalHistory() — returns parsed records from an existing file
 *
 * All external dependencies are mocked:
 *   fs                — readFileSync / appendFileSync / existsSync / mkdirSync
 *   ./agent-runner.js — runAgent returns STUB_RESPONSES entry for the agent
 *   ./logger.js       — silenced
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock fs ──────────────────────────────────────────────────────────────────
const mockAppendFileSync = vi.fn();
const mockReadFileSync   = vi.fn(() => '');
const mockExistsSync     = vi.fn(() => false);
const mockMkdirSync      = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    appendFileSync: mockAppendFileSync,
    readFileSync:   mockReadFileSync,
    existsSync:     mockExistsSync,
    mkdirSync:      mockMkdirSync,
  };
});

// ─── Mock agent-runner ────────────────────────────────────────────────────────
vi.mock('../engine/agent-runner.js', () => ({
  runAgent: vi.fn(async (agent) => {
    const { STUB_RESPONSES } = await import('../engine/prompt-eval.js');
    return STUB_RESPONSES[agent] ?? '';
  }),
}));

// ─── Mock logger ──────────────────────────────────────────────────────────────
vi.mock('../engine/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Import SUT ───────────────────────────────────────────────────────────────
import {
  scoreResponse,
  evalAgent,
  evalAll,
  recordEvalResult,
  readEvalHistory,
  STUB_RESPONSES,
  AGENT_CASES,
  PASS_THRESHOLD,
  MAX_SCORE,
} from '../engine/prompt-eval.js';

// ─── scoreResponse — PATCH agents ────────────────────────────────────────────

describe('scoreResponse — debugger', () => {
  it('scores the canonical stub response at or above PASS_THRESHOLD', () => {
    const { score } = scoreResponse('debugger', STUB_RESPONSES.debugger);
    expect(score).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });

  it('gives 0 when no PATCH block is present', () => {
    const { score, notes } = scoreResponse('debugger', 'Here is my analysis without a patch.');
    expect(score).toBe(0);
    expect(notes.some(n => n.includes('no PATCH block'))).toBe(true);
  });

  it('deducts score when PATCH JSON is malformed', () => {
    const bad = 'Explanation: root cause found.\n\nPATCH:\n{ file: "x.js", content: oops }';
    const { score, notes } = scoreResponse('debugger', bad);
    expect(score).toBeLessThan(PASS_THRESHOLD);
    expect(notes.some(n => n.includes('JSON parse error'))).toBe(true);
  });

  it('gives full credit for PATCH: null when expectNull is true', () => {
    const raw = 'Explanation: no change needed.\n\nPATCH: null';
    const { score } = scoreResponse('debugger', raw, true);
    expect(score).toBe(MAX_SCORE);
  });

  it('does not give full credit for PATCH: null when expectNull is false', () => {
    const raw = 'Explanation: no change needed.\n\nPATCH: null';
    const { score } = scoreResponse('debugger', raw, false);
    // PATCH block present (+2), null value with expectNull=false → no bonus
    expect(score).toBeLessThan(PASS_THRESHOLD);
  });

  it('scores a missing `file` field lower', () => {
    const raw = `Explanation: root cause. It is this. The fix does this.

PATCH:
{
  "content": "export function foo() {}"
}`;
    const { score } = scoreResponse('debugger', raw);
    // Missing file: -1 point
    expect(score).toBeLessThan(MAX_SCORE);
  });

  it('scores a missing `content` field lower', () => {
    const raw = `Explanation: root cause. It is this. The fix does this.

PATCH:
{
  "file": "engine/foo.js"
}`;
    const { score } = scoreResponse('debugger', raw);
    expect(score).toBeLessThan(MAX_SCORE);
  });

  it('fails when Explanation section is absent', () => {
    const raw = `PATCH:
{
  "file": "engine/foo.js",
  "content": "export function foo() {}"
}`;
    const { score, notes } = scoreResponse('debugger', raw);
    expect(notes.some(n => n.includes('reasoning section') && n.includes('missing'))).toBe(true);
    expect(score).toBeLessThan(MAX_SCORE);
  });
});

describe('scoreResponse — feature-builder', () => {
  it('scores the canonical stub at or above PASS_THRESHOLD', () => {
    const { score } = scoreResponse('feature-builder', STUB_RESPONSES['feature-builder']);
    expect(score).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });

  it('looks for Design: section, not Explanation:', () => {
    const withDesign = `Design: The feature does X. It integrates with Y. It handles Z edge case.

PATCH:
{
  "file": "server.js",
  "content": "app.get('/health', (_, res) => res.json({ ok: true }));"
}`;
    const { notes } = scoreResponse('feature-builder', withDesign);
    expect(notes.some(n => n.includes('Design:') && n.includes('PASS'))).toBe(true);
  });
});

describe('scoreResponse — refactorer', () => {
  it('scores the canonical stub at or above PASS_THRESHOLD', () => {
    const { score } = scoreResponse('refactorer', STUB_RESPONSES.refactorer);
    expect(score).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });

  it('looks for Changes: section', () => {
    const raw = `Changes:
- Extracted helper

PATCH:
{
  "file": "engine/x.js",
  "content": "export function x() { return 1; }"
}`;
    const { notes } = scoreResponse('refactorer', raw);
    expect(notes.some(n => n.includes('Changes:'))).toBe(true);
  });
});

describe('scoreResponse — security-editor', () => {
  it('scores the canonical stub at or above PASS_THRESHOLD', () => {
    const { score } = scoreResponse('security-editor', STUB_RESPONSES['security-editor']);
    expect(score).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });

  it('looks for Vulnerabilities: section', () => {
    const raw = `Vulnerabilities:
[HIGH] Path traversal at line 5. User input is passed directly. An attacker can escape the root.

PATCH:
{
  "file": "server.js",
  "content": "app.get('/file', (req, res) => res.status(403).send());"
}`;
    const { notes } = scoreResponse('security-editor', raw);
    expect(notes.some(n => n.includes('Vulnerabilities:'))).toBe(true);
  });
});

// ─── scoreResponse — planner ──────────────────────────────────────────────────

describe('scoreResponse — planner', () => {
  it('scores a well-formed plan at or above PASS_THRESHOLD', () => {
    const plan = JSON.stringify({
      tasks: [
        { id: 'A', agent: 'feature-builder', description: 'Implement POST /api/users in server.js with validation and error handling', depends_on: [] },
        { id: 'B', agent: 'review-guard',    description: 'Review all changes from step A for correctness and security issues', depends_on: ['A'] },
      ],
    });
    const { score } = scoreResponse('planner', plan);
    expect(score).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });

  it('fails on invalid JSON', () => {
    const { score, notes } = scoreResponse('planner', 'not json at all');
    expect(score).toBe(0);
    expect(notes.some(n => n.includes('JSON parse error'))).toBe(true);
  });

  it('fails when tasks array is missing', () => {
    const { score, notes } = scoreResponse('planner', JSON.stringify({ steps: [] }));
    expect(score).toBeLessThan(PASS_THRESHOLD);
    expect(notes.some(n => n.includes('`tasks` array missing'))).toBe(true);
  });

  it('fails when tasks array is empty', () => {
    const { score, notes } = scoreResponse('planner', JSON.stringify({ tasks: [] }));
    expect(score).toBeLessThan(PASS_THRESHOLD);
    expect(notes.some(n => n.includes('tasks array is empty'))).toBe(true);
  });

  it('penalises unknown agent names', () => {
    const plan = JSON.stringify({
      tasks: [
        { id: 'A', agent: 'super-coder', description: 'Do something important with engine/foo.js and bar.js files', depends_on: [] },
      ],
    });
    const { notes } = scoreResponse('planner', plan);
    expect(notes.some(n => n.includes('unknown agents'))).toBe(true);
  });

  it('strips markdown fences before parsing', () => {
    const fenced = '```json\n' + JSON.stringify({
      tasks: [
        { id: 'A', agent: 'debugger', description: 'Fix the TypeError in engine/job-store.js at line 14', depends_on: [] },
      ],
    }) + '\n```';
    const { score } = scoreResponse('planner', fenced);
    expect(score).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });
});

// ─── scoreResponse — review-guard ────────────────────────────────────────────

describe('scoreResponse — review-guard', () => {
  it('scores "APPROVED" at MAX_SCORE', () => {
    const { score } = scoreResponse('review-guard', 'APPROVED');
    expect(score).toBe(MAX_SCORE);
  });

  it('scores a well-formed REJECTED at or above PASS_THRESHOLD', () => {
    const raw = 'REJECTED\nReason:\n- eval() usage is unsafe\n- Missing error handling';
    const { score } = scoreResponse('review-guard', raw);
    expect(score).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });

  it('fails when response is neither APPROVED nor REJECTED', () => {
    const { score, notes } = scoreResponse('review-guard', 'Looks good to me!');
    expect(score).toBe(0);
    expect(notes.some(n => n.includes('neither'))).toBe(true);
  });

  it('penalises extra text before APPROVED', () => {
    const { score } = scoreResponse('review-guard', 'After review: APPROVED');
    expect(score).toBeLessThan(MAX_SCORE);
  });

  it('fails REJECTED with no reason bullets', () => {
    const { score, notes } = scoreResponse('review-guard', 'REJECTED\nReason: it is bad');
    // No bullet lines → loses 2 points
    expect(notes.some(n => n.includes('no reason bullets'))).toBe(true);
  });

  it('scores the canonical stub response', () => {
    const { score } = scoreResponse('review-guard', STUB_RESPONSES['review-guard']);
    expect(score).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });
});

// ─── scoreResponse — test-writer ──────────────────────────────────────────────

describe('scoreResponse — test-writer', () => {
  it('scores the canonical stub at MAX_SCORE', () => {
    const { score } = scoreResponse('test-writer', STUB_RESPONSES['test-writer']);
    expect(score).toBe(MAX_SCORE);
  });

  it('fails when no import statement', () => {
    const { notes } = scoreResponse('test-writer', 'describe("x", () => { it("y", () => expect(1).toBe(1)); });');
    expect(notes.some(n => n.includes('no import statement'))).toBe(true);
  });

  it('fails when no describe block', () => {
    const raw = "import { expect } from 'vitest';\nit('x', () => expect(1).toBe(1));";
    const { notes } = scoreResponse('test-writer', raw);
    expect(notes.some(n => n.includes('no describe()'))).toBe(true);
  });

  it('fails when no it() or test() calls', () => {
    const raw = "import x from 'x';\ndescribe('x', () => { expect(1).toBe(1); });";
    const { notes } = scoreResponse('test-writer', raw);
    expect(notes.some(n => n.includes('no it() or test()'))).toBe(true);
  });

  it('penalises real network calls', () => {
    const raw = `import { describe, it, expect } from 'vitest';
describe('x', () => {
  it('fetches', async () => {
    const r = await fetch('https://api.example.com/data');
    expect(r.ok).toBe(true);
  });
});`;
    const { notes } = scoreResponse('test-writer', raw);
    expect(notes.some(n => n.includes('real network call'))).toBe(true);
  });
});

// ─── scoreResponse — meta-reviewer ───────────────────────────────────────────

describe('scoreResponse — meta-reviewer', () => {
  it('scores the canonical stub at MAX_SCORE', () => {
    const { score } = scoreResponse('meta-reviewer', STUB_RESPONSES['meta-reviewer']);
    expect(score).toBe(MAX_SCORE);
  });

  it('fails when ## Summary is missing', () => {
    const raw = '## Findings\n| 1 | HIGH | x | y | z |\n## Top 3 improvements\n1. a\n2. b\n3. c';
    const { notes } = scoreResponse('meta-reviewer', raw);
    expect(notes.some(n => n.includes('## Summary') && n.includes('missing'))).toBe(true);
  });

  it('fails when ## Findings is missing', () => {
    const raw = '## Summary\nEverything worked.\n## Top 3 improvements\n1. a\n2. b\n3. c';
    const { notes } = scoreResponse('meta-reviewer', raw);
    expect(notes.some(n => n.includes('## Findings') && n.includes('missing'))).toBe(true);
  });

  it('fails when no finding rows in table', () => {
    const raw = '## Summary\nOk.\n## Findings\n| # | Severity |\n## Top 3 improvements\n1. x';
    const { notes } = scoreResponse('meta-reviewer', raw);
    expect(notes.some(n => n.includes('no finding rows'))).toBe(true);
  });
});

// ─── scoreResponse — unknown agent ───────────────────────────────────────────

describe('scoreResponse — unknown agent', () => {
  it('returns score 0 for an unrecognised agent', () => {
    const { score, notes } = scoreResponse('imaginary-agent', 'some output');
    expect(score).toBe(0);
    expect(notes.some(n => n.includes('Unknown agent type'))).toBe(true);
  });
});

// ─── evalAgent (dryRun) ───────────────────────────────────────────────────────

describe('evalAgent — dryRun mode', () => {
  it('passes all cases for debugger using the stub response', async () => {
    const result = await evalAgent('debugger', AGENT_CASES.debugger, { dryRun: true });
    expect(result.agent).toBe('debugger');
    expect(result.passed).toBe(true);
  });

  it('passes all cases for review-guard using the stub response', async () => {
    const result = await evalAgent('review-guard', AGENT_CASES['review-guard'], { dryRun: true });
    expect(result.passed).toBe(true);
  });

  it('passes all cases for test-writer using the stub response', async () => {
    const result = await evalAgent('test-writer', AGENT_CASES['test-writer'], { dryRun: true });
    expect(result.passed).toBe(true);
  });

  it('returns the correct structure', async () => {
    const result = await evalAgent('debugger', AGENT_CASES.debugger, { dryRun: true });
    expect(result).toMatchObject({
      agent:      'debugger',
      passed:     expect.any(Boolean),
      passCount:  expect.any(Number),
      totalCases: AGENT_CASES.debugger.length,
      cases:      expect.any(Array),
    });
    for (const c of result.cases) {
      expect(c).toMatchObject({
        caseId:   expect.any(String),
        passed:   expect.any(Boolean),
        score:    expect.any(Number),
        maxScore: MAX_SCORE,
        notes:    expect.any(Array),
      });
    }
  });

  it('marks an agent as failed when stub is replaced with empty string', async () => {
    const cases = [{ id: 'bad', task: 'fix something', context: {} }];
    // Pass empty string as the stub — score will be 0
    vi.doMock('../engine/agent-runner.js', () => ({
      runAgent: vi.fn(async () => ''),
    }));
    const result = await evalAgent('debugger', cases, { dryRun: false });
    // Empty response → score 0 → case fails → agent fails
    expect(result.cases[0].passed).toBe(false);
  });
});

// ─── evalAll (dryRun) ─────────────────────────────────────────────────────────

describe('evalAll — dryRun mode', () => {
  it('returns a report with passed=true when all stubs are correct', async () => {
    const report = await evalAll({ dryRun: true });
    expect(report.passed).toBe(true);
    expect(typeof report.summary).toBe('string');
    expect(report.summary).toMatch(/RESULT: PASS/);
    expect(Array.isArray(report.agents)).toBe(true);
  });

  it('includes every agent in the roster', async () => {
    const report = await evalAll({ dryRun: true });
    const names  = report.agents.map(a => a.agent);
    for (const agent of Object.keys(AGENT_CASES)) {
      expect(names).toContain(agent);
    }
  });

  it('summary contains per-agent pass/fail lines', async () => {
    const report = await evalAll({ dryRun: true });
    expect(report.summary).toMatch(/debugger/);
    expect(report.summary).toMatch(/review-guard/);
  });
});

// ─── recordEvalResult ─────────────────────────────────────────────────────────

describe('recordEvalResult', () => {
  beforeEach(() => {
    mockAppendFileSync.mockReset();
    mockExistsSync.mockReset();
    mockMkdirSync.mockReset();
  });

  it('creates the directory when it does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    recordEvalResult({ agent: 'debugger', passed: true, passCount: 2, totalCases: 2, cases: [] });
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.claude'),
      expect.objectContaining({ recursive: true })
    );
  });

  it('does not create directory when it already exists', () => {
    mockExistsSync.mockReturnValue(true);
    recordEvalResult({ agent: 'debugger', passed: true, passCount: 2, totalCases: 2, cases: [] });
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('appends a valid JSONL line', () => {
    mockExistsSync.mockReturnValue(true);
    recordEvalResult({
      agent:      'debugger',
      passed:     true,
      passCount:  2,
      totalCases: 2,
      cases:      [{ caseId: 'c1', passed: true, score: 8, notes: [] }],
    });
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const [, content] = mockAppendFileSync.mock.calls[0];
    const parsed = JSON.parse(content.trim());
    expect(parsed.agent).toBe('debugger');
    expect(parsed.passed).toBe(true);
    expect(typeof parsed.ts).toBe('string');
  });

  it('does not throw when appendFileSync fails', () => {
    mockExistsSync.mockReturnValue(true);
    mockAppendFileSync.mockImplementation(() => { throw new Error('disk full'); });
    expect(() =>
      recordEvalResult({ agent: 'debugger', passed: true, passCount: 1, totalCases: 1, cases: [] })
    ).not.toThrow();
  });
});

// ─── readEvalHistory ──────────────────────────────────────────────────────────

describe('readEvalHistory', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  it('returns empty array when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = readEvalHistory();
    expect(result).toEqual([]);
  });

  it('returns parsed JSONL records', () => {
    mockExistsSync.mockReturnValue(true);
    const record = { ts: new Date().toISOString(), agent: 'debugger', passed: true, passCount: 2, total: 2, cases: [] };
    mockReadFileSync.mockReturnValue(JSON.stringify(record) + '\n');
    const result = readEvalHistory();
    expect(result).toHaveLength(1);
    expect(result[0].agent).toBe('debugger');
  });

  it('returns at most n records', () => {
    mockExistsSync.mockReturnValue(true);
    const lines = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({ ts: new Date().toISOString(), agent: 'debugger', passed: true, passCount: 1, total: 1, cases: [], seq: i })
    ).join('\n');
    mockReadFileSync.mockReturnValue(lines);
    const result = readEvalHistory(5);
    expect(result).toHaveLength(5);
    expect(result[result.length - 1].seq).toBe(29);
  });

  it('returns empty array when file content is unparseable', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json\nalso not json\n');
    // Should not throw; returns empty
    expect(() => readEvalHistory()).not.toThrow();
  });
});
