// engine/adapters/priority-tiers.js
//
// SQS and Redis Streams have no native per-message priority (unlike BullMQ).
// Both adapters fan work across 4 physical queues/streams — one per tier —
// and poll them in priority order. This module is the single source of
// truth for tier constants + resolution so both backends stay consistent.

export const Priority = {
  CRITICAL: 0,
  HIGH:     1,
  NORMAL:   5,
  LOW:      10
};

// Ordered highest → lowest; workers poll in this order each cycle.
export const TIERS = ['critical', 'high', 'normal', 'low'];

export function tierForPriority(priority = Priority.NORMAL) {
  if (priority <= Priority.CRITICAL) return 'critical';
  if (priority <= Priority.HIGH) return 'high';
  if (priority <= Priority.NORMAL) return 'normal';
  return 'low';
}
