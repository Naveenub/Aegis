import { getQueueAdapter } from './queue-adapter.js';

// Public queue surface for the rest of the app. Delegates to whichever
// backend adapter is selected (see engine/queue-adapter.js).
const adapter = getQueueAdapter();

export const Priority               = adapter.Priority;
export const getTaskQueue           = adapter.getTaskQueue;
export const getDeadLetterQueue     = adapter.getDeadLetterQueue;
export const getQueueEvents         = adapter.getQueueEvents;
export const addStep                = adapter.addStep;
export const createTaskWorker       = adapter.createTaskWorker;
export const createDeadLetterWorker = adapter.createDeadLetterWorker;

// Legacy single-tenant exports kept for backwards compat (maps to DEFAULT_TENANT)
export const taskQueue       = getTaskQueue();
export const deadLetterQueue = getDeadLetterQueue();
export const queueEvents     = getQueueEvents();
