import { deadLetterQueue } from '../engine/queue.js';

const jobs = await deadLetterQueue.getJobs(['waiting', 'failed']);

for (const job of jobs) {
  console.log({
    id: job.id,
    step: job.data.step.description,
    error: job.data.error
  });
}
