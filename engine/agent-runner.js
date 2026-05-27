import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { searchMemory } from './vector-memory.js';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';
import { scanRepo } from './repo-scanner.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Agents that must emit a PATCH block — enforce JSON output format in system prompt
const PATCH_AGENTS = new Set([
  'debugger',
  'feature-builder',
  'refactorer',
  'security-editor',
]);

// How many bytes of each file to inline (keeps prompt manageable)
const FILE_INLINE_LIMIT = 8_000;

/**
 * Read a bounded slice of a source file for context injection.
 * Returns an empty string if the file cannot be read.
 */
function readFileSafe(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.length <= FILE_INLINE_LIMIT) return content;
    // Keep head + tail so both imports and exports are visible
    const half = FILE_INLINE_LIMIT / 2;
    return (
      content.slice(0, half) +
      `\n\n... [${content.length - FILE_INLINE_LIMIT} bytes omitted] ...\n\n` +
      content.slice(-half)
    );
  } catch {
    return '';
  }
}

/**
 * Build a compact repo map: relative path + first-line summary only.
 * Full file content is included only for files named in `relevantFiles`.
 */
function buildRepoContext(relevantFiles = []) {
  const allFiles = scanRepo().filter(
    (f) =>
      !f.includes('node_modules') &&
      !f.includes('.git') &&
      !f.endsWith('.lock') &&
      !f.endsWith('.log')
  );

  const repoMap = allFiles
    .map((f) => path.relative(process.cwd(), f))
    .join('\n');

  const inlined = relevantFiles
    .map((f) => {
      const abs = path.isAbsolute(f) ? f : path.join(process.cwd(), f);
      const content = readFileSafe(abs);
      if (!content) return null;
      return `### ${path.relative(process.cwd(), abs)}\n\`\`\`\n${content}\n\`\`\``;
    })
    .filter(Boolean)
    .join('\n\n');

  return { repoMap, inlined };
}

/**
 * Run an agent against the Claude API with a rich, structured prompt.
 *
 * @param {string}   agent     - Name matching a .claude/agents/<agent>.md file
 * @param {string}   task      - The concrete task description
 * @param {object}   context   - Optional extra context:
 *                                 context.files    - array of file paths to inline
 *                                 context.error    - previous error output (for debug loop)
 *                                 context.patch    - previous patch attempt (for review loop)
 * @param {string}   tenantId  - Tenant identifier
 */
export async function runAgent(
  agent,
  task,
  context = {},
  tenantId = DEFAULT_TENANT
) {
  assertTenantId(tenantId);

  // ── 1. Load agent persona ────────────────────────────────────────────────
  const agentPersona = fs.readFileSync(
    `.claude/agents/${agent}.md`,
    'utf-8'
  );

  const isPatchAgent = PATCH_AGENTS.has(agent);

  // ── 2. Build system prompt ───────────────────────────────────────────────
  const systemPrompt = [
    agentPersona.trim(),
    '',
    '## Output contract',
    isPatchAgent
      ? [
          'You MUST end your response with a PATCH block in this exact format:',
          '',
          'PATCH:',
          '{',
          '  "file": "relative/path/to/file.js",',
          '  "content": "FULL file content — never a diff or partial snippet"',
          '}',
          '',
          'Rules:',
          '- `content` must be the complete, valid file ready to write to disk.',
          '- Do not truncate. Do not use "..." placeholders.',
          '- If no change is needed, still emit PATCH: null',
        ].join('\n')
      : agent === 'planner'
      ? [
          'Respond ONLY with a valid JSON object. No markdown fences, no explanation.',
          'Schema:',
          '{',
          '  "tasks": [',
          '    { "id": "A", "agent": "<agent-name>", "description": "<clear task>", "depends_on": [] },',
          '    ...',
          '  ]',
          '}',
          'Available agents: feature-builder, debugger, refactorer, test-writer, security-editor, review-guard',
        ].join('\n')
      : agent === 'review-guard'
      ? [
          'Respond with exactly one of:',
          '  APPROVED',
          '  REJECTED\\nReason: <concise explanation>',
          'No other text.',
        ].join('\n')
      : agent === 'test-writer'
      ? 'Output the complete test file content only. Include all imports.'
      : 'Be concise. Use markdown only for code blocks.',
    '',
    '## Repository layout',
    '```',
    buildRepoContext(context.files ?? []).repoMap,
    '```',
  ].join('\n');

  // ── 3. Build user message ────────────────────────────────────────────────
  const { inlined } = buildRepoContext(context.files ?? []);

  const memory = await searchMemory(task, 3, tenantId);
  const memorySection =
    memory.length > 0
      ? [
          '## Relevant past fixes (verify before reusing)',
          ...memory.map(
            (m, i) =>
              `### Past fix ${i + 1}\n${m.text}\n\nPatch applied:\n\`\`\`json\n${m.patch}\n\`\`\``
          ),
        ].join('\n\n')
      : '';

  const inlinedSection = inlined
    ? `## Relevant source files\n\n${inlined}`
    : '';

  const errorSection = context.error
    ? `## Previous error output\n\`\`\`\n${context.error}\n\`\`\``
    : '';

  const previousPatchSection = context.patch
    ? `## Previous patch attempt\n\`\`\`json\n${context.patch}\n\`\`\``
    : '';

  const userMessage = [
    '## Task',
    task.trim(),
    errorSection,
    previousPatchSection,
    inlinedSection,
    memorySection,
  ]
    .filter(Boolean)
    .join('\n\n');

  // ── 4. Call the API ──────────────────────────────────────────────────────
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}