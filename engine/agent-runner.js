import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { searchMemory } from './memory.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

export async function runAgent(agent, task, context = {}) {
  const prompt = fs.readFileSync(`.claude/agents/${agent}.md`, 'utf-8');

  const memory = searchMemory(task);
  
  const memoryContext = memory.length
  ? `\nRelevant past fixes:\n${JSON.stringify(memory, null, 2)}`
  : '';

  const response = await client.messages.create({
    model: "claude-3-sonnet-20240229",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: `${prompt}\n\nTASK:\n${task}${memoryContext}`
      }
    ]
  });

  return response.content[0].text;
}
