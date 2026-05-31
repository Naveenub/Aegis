/**
 * tests/agent-runner.test.js
 *
 * Unit tests for engine/agent-runner.js
 *
 * Covers:
 *   runAgent()   — system prompt construction (patch-agent contract, planner schema,
 *                  review-guard contract, test-writer contract), memory injection,
 *                  error/previous-patch context sections, Anthropic API call shape,
 *                  and response assembly from content blocks.
 *
 * All external dependencies are mocked:
 *   @anthropic-ai/sdk  — returns a configurable fake response
 *   ./vector-memory.js — searchMemory returns []
 *   ./repo-scanner.js  — scanRepo returns a predictable file list
 *   fs                 — readFileSync returns canned persona content
 *   dotenv             — no-op
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Anthropic SDK ───────────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// ─── Mock vector-memory ───────────────────────────────────────────────────────

vi.mock('../engine/vector-memory.js', () => ({
  searchMemory: vi.fn(async () => []),
}));

// ─── Mock repo-scanner ────────────────────────────────────────────────────────

vi.mock('../engine/repo-scanner.js', () => ({
  scanRepo: vi.fn(() => ['engine/agent-runner.js', 'engine/review-system.js']),
}));

// ─── Mock fs ─────────────────────────────────────────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFileSync: vi.fn((filePath) => {
      if (String(filePath).includes('.claude/agents/')) {
        return `# Agent persona for ${filePath}`;
      }
      // For other files (e.g. inlined source) return short content
      return '// source content';
    }),
  };
});

// ─── Mock dotenv ─────────────────────────────────────────────────────────────

vi.mock('dotenv', () => ({ default: { config: vi.fn() }, config: vi.fn() }));

// ─── Module under test ────────────────────────────────────────────────────────

import { runAgent } from '../engine/agent-runner.js';
import { searchMemory } from '../engine/vector-memory.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function fakeResponse(text) {
  return {
    content: [{ type: 'text', text }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: API returns a generic text response
  mockCreate.mockResolvedValue(fakeResponse('Some response text'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Basic invocation
// ═══════════════════════════════════════════════════════════════════════════════

describe('runAgent() — basic invocation', () => {
  it('returns the text content from the API response', async () => {
    mockCreate.mockResolvedValue(fakeResponse('Hello from Claude'));
    const result = await runAgent('planner', 'Build a feature', {}, 'default');
    expect(result).toBe('Hello from Claude');
  });

  it('concatenates multiple text content blocks', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'Part one ' },
        { type: 'text', text: 'part two' },
      ],
    });
    const result = await runAgent('planner', 'Build', {}, 'default');
    expect(result).toBe('Part one part two');
  });

  it('ignores non-text content blocks', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'search', input: {} },
        { type: 'text', text: 'Only this' },
      ],
    });
    const result = await runAgent('planner', 'Build', {}, 'default');
    expect(result).toBe('Only this');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Anthropic API call shape
// ═══════════════════════════════════════════════════════════════════════════════

describe('runAgent() — API call parameters', () => {
  it('calls messages.create with model and max_tokens', async () => {
    await runAgent('planner', 'task', {}, 'default');
    const call = mockCreate.mock.calls[0][0];
    expect(call).toHaveProperty('model');
    expect(call).toHaveProperty('max_tokens');
    expect(typeof call.model).toBe('string');
    expect(typeof call.max_tokens).toBe('number');
  });

  it('passes a system prompt and a single user message', async () => {
    await runAgent('planner', 'task', {}, 'default');
    const call = mockCreate.mock.calls[0][0];
    expect(typeof call.system).toBe('string');
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].role).toBe('user');
  });

  it('includes the task in the user message content', async () => {
    await runAgent('planner', 'implement feature X', {}, 'default');
    const userContent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userContent).toContain('implement feature X');
  });

  it('includes the agent persona in the system prompt', async () => {
    await runAgent('debugger', 'fix bug', {}, 'default');
    const systemPrompt = mockCreate.mock.calls[0][0].system;
    expect(systemPrompt).toContain('debugger');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Output contract per agent type
// ═══════════════════════════════════════════════════════════════════════════════

describe('runAgent() — output contract in system prompt', () => {
  const PATCH_AGENTS = ['debugger', 'feature-builder', 'refactorer', 'security-editor'];

  for (const agent of PATCH_AGENTS) {
    it(`includes PATCH block requirement in system prompt for ${agent}`, async () => {
      await runAgent(agent, 'task', {}, 'default');
      const system = mockCreate.mock.calls[0][0].system;
      expect(system).toContain('PATCH:');
    });
  }

  it('includes JSON schema contract in planner system prompt', async () => {
    await runAgent('planner', 'plan the work', {}, 'default');
    const system = mockCreate.mock.calls[0][0].system;
    expect(system).toContain('"tasks"');
  });

  it('includes APPROVED/REJECTED contract for review-guard', async () => {
    await runAgent('review-guard', 'review this patch', {}, 'default');
    const system = mockCreate.mock.calls[0][0].system;
    expect(system).toContain('APPROVED');
    expect(system).toContain('REJECTED');
  });

  it('includes test file instruction for test-writer', async () => {
    await runAgent('test-writer', 'write tests', {}, 'default');
    const system = mockCreate.mock.calls[0][0].system;
    expect(system.toLowerCase()).toMatch(/test/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Context injection — error and previous patch
// ═══════════════════════════════════════════════════════════════════════════════

describe('runAgent() — context sections', () => {
  it('includes error section when context.error is provided', async () => {
    await runAgent('debugger', 'fix it', { error: 'TypeError: x is undefined' }, 'default');
    const userContent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userContent).toContain('TypeError: x is undefined');
  });

  it('includes previous patch section when context.patch is provided', async () => {
    const previousPatch = JSON.stringify({ file: 'a.js', content: 'old' });
    await runAgent('debugger', 'fix it', { patch: previousPatch }, 'default');
    const userContent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userContent).toContain('a.js');
  });

  it('omits error section when context.error is absent', async () => {
    await runAgent('planner', 'plan', {}, 'default');
    const userContent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userContent).not.toContain('Previous error output');
  });

  it('omits patch section when context.patch is absent', async () => {
    await runAgent('planner', 'plan', {}, 'default');
    const userContent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userContent).not.toContain('Previous patch attempt');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Memory injection
// ═══════════════════════════════════════════════════════════════════════════════

describe('runAgent() — memory injection', () => {
  it('calls searchMemory with the task string and tenantId', async () => {
    await runAgent('debugger', 'fix the widget', {}, 'tenant-42');
    expect(searchMemory).toHaveBeenCalledWith('fix the widget', 3, 'tenant-42');
  });

  it('includes past-fix context in user message when searchMemory returns results', async () => {
    searchMemory.mockResolvedValue([
      { text: 'old fix description', patch: '{"file":"x.js","content":"fixed"}' },
    ]);
    await runAgent('debugger', 'fix bug', {}, 'default');
    const userContent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userContent).toContain('old fix description');
  });

  it('does not include memory section when searchMemory returns empty array', async () => {
    searchMemory.mockResolvedValue([]);
    await runAgent('planner', 'plan it', {}, 'default');
    const userContent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userContent).not.toContain('Relevant past fixes');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Tenant validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('runAgent() — tenant validation', () => {
  it('throws for an empty tenantId', async () => {
    await expect(runAgent('planner', 'task', {}, '')).rejects.toThrow();
  });

  it('throws for a tenantId that is undefined', async () => {
    await expect(runAgent('planner', 'task', {}, undefined)).rejects.toThrow();
  });
});
