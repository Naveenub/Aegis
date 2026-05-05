import { Worker } from 'bullmq';
import { runAgent } from '../engine/agent-runner.js';

new Worker('tasks', async job => {
  return await runAgent(job.data.agent, job.data.task, {});
});
