import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis();

export const taskQueue = new Queue('aegis-tasks', { connection });
export const queueEvents = new QueueEvents('aegis-tasks', { connection });
