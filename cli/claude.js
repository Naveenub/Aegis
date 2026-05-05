#!/usr/bin/env node
import { runSystem } from '../engine/orchestrator.js';

const task = process.argv.slice(2).join(' ');

if (!task) {
  console.log('Usage: claude "task"');
  process.exit(1);
}

await runSystem(task);
