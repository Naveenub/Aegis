import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis();

export const taskQueue = new Queue('aegis-tasks', { connection });

export const queue = new Queue('tasks', {
  connection: { host: '127.0.0.1', port: 6379 }
});
