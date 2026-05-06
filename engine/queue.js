import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis();

export const taskQueue = new Queue('aegis-tasks', {
  connection,
  defaultJobOptions: {
    attempts: 3, // queue-level retries
    backoff: {
      type: 'exponential',
      delay: 2000 // 2s → 4s → 8s
    },
    removeOnComplete: true,
    removeOnFail: false // keep failed jobs for DLQ
  }
});

export const queueEvents = new QueueEvents('aegis-tasks', { connection });

export const deadLetterQueue = new Queue('aegis-dead-letter', {
  connection
});
