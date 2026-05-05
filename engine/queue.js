import { Queue } from 'bullmq';

export const queue = new Queue('tasks', {
  connection: { host: '127.0.0.1', port: 6379 }
});
