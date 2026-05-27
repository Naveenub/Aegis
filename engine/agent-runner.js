import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { searchMemory } from './vector-memory.js';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function runAgent(agent, task, context = {}, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const prompt = fs.readFileSync(`.claude/agents/${agent}.md`, 'utf-8');

  // Memory lookup is scoped to this tenant — other tenants' fixes never surface here
  const memory = await searchMemory(task, 3, tenantId);

  const memoryContext = memory.length
    ? `\nRelevant past fixes:\n${memory.map(m => `${m.text}\nPatch: ${m.patch}`).join('\n\n')}`
    : '';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content: `${prompt}\n\nTASK:\n${task}${memoryContext}`
      }
    ]
  });

  return response.content[0].text;
}