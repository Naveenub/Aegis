/**
 * engine/template-store.js — reusable workflow templates
 *
 * A template freezes a validated (task, tasks[]) pair so it can be re-run
 * via orchestrator.runTemplate() without invoking the planner again.
 *
 * Templates are tenant-scoped the same way workflows are (see the
 * loadMetaWithOwnerCheck pattern in workflow-store.js): a template created
 * for one tenant throws TemplateTenantMismatchError if a different tenant
 * tries to read or run it.
 *
 * Redis key layout
 * ─────────────────
 *   aegis:template:{id}            HASH — { tenantId, task, tasks (JSON), version, createdAt }
 *   aegis:template:{id}:versions   LIST — JSON snapshots of every prior version, oldest first
 *
 * Versioning: saving over an existing id archives the current hash contents
 * onto the versions list (so nothing is lost) before overwriting, and bumps
 * `version`. diffTemplateTasks() compares two tasks[] arrays by task id so
 * callers can see what changed between runs.
 */

import IORedis from 'ioredis';
import crypto from 'crypto';

const redis = new IORedis(process.env.REDIS_URL || undefined, {
  lazyConnect:          true,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: 1,
  connectTimeout:       3000,
  retryStrategy:        () => null,
});
// Without a listener, ioredis logs an unhandled 'error' event for every
// connection failure. Rejections already surface per-command to callers,
// so this listener only silences that duplicate console noise.
redis.on('error', () => {});

const TEMPLATE_PREFIX = 'aegis:template:';
const versionsKey = (id) => `${TEMPLATE_PREFIX}${id}:versions`;

export class TemplateTenantMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateTenantMismatchError';
    this.code = 'TENANT_MISMATCH';
  }
}

/**
 * Save a validated (task, tasks) pair as a reusable template.
 *
 * @param {object}   opts
 * @param {string}   [opts.id]        - client-supplied id; generated (UUID) when omitted
 * @param {string}   opts.task        - original task description
 * @param {object[]} opts.tasks       - validated plan tasks (orchestrator.validatePlan output)
 * @param {string}   [opts.tenantId]
 * @returns {Promise<string>} the template id
 */
export async function saveTemplate({ id, task, tasks, tenantId = null }) {
  const templateId = id ?? crypto.randomUUID();
  const key = TEMPLATE_PREFIX + templateId;

  const existing = await redis.hgetall(key);
  let nextVersion = 1;

  if (existing && Object.keys(existing).length > 0) {
    if (tenantId !== null && existing.tenantId && existing.tenantId !== tenantId) {
      throw new TemplateTenantMismatchError(
        `Template "${templateId}" does not belong to tenant "${tenantId}".`
      );
    }
    nextVersion = Number(existing.version ?? 1) + 1;
    await redis.rpush(versionsKey(templateId), JSON.stringify({
      ...existing,
      version: Number(existing.version ?? 1),
    }));
  }

  await redis.hset(key, {
    tenantId:  tenantId ?? '',
    task,
    tasks:     JSON.stringify(tasks),
    version:   nextVersion.toString(),
    createdAt: Date.now().toString(),
  });

  return templateId;
}

/**
 * List archived versions of a template, oldest first. Does not include the
 * current (latest) version — fetch that with getTemplate().
 *
 * @param {string}      templateId
 * @param {string|null} [tenantId]
 * @returns {Promise<{ version, task, tasks, createdAt }[]>}
 */
export async function getTemplateVersions(templateId, tenantId = null) {
  await getTemplate(templateId, tenantId); // reuses the tenant-ownership check
  const raw = await redis.lrange(versionsKey(templateId), 0, -1);
  return raw.map(entry => {
    const v = JSON.parse(entry);
    return {
      version:   v.version,
      task:      v.task,
      tasks:     JSON.parse(v.tasks),
      createdAt: Number(v.createdAt),
    };
  });
}

/**
 * Diff two task lists (as stored on a template) by task id.
 *
 * @param {object[]} oldTasks
 * @param {object[]} newTasks
 * @returns {{ added: object[], removed: object[], changed: { id: string, before: object, after: object }[] }}
 */
export function diffTemplateTasks(oldTasks, newTasks) {
  const oldById = new Map(oldTasks.map(t => [t.id, t]));
  const newById = new Map(newTasks.map(t => [t.id, t]));

  const added   = newTasks.filter(t => !oldById.has(t.id));
  const removed = oldTasks.filter(t => !newById.has(t.id));
  const changed = [];

  for (const [id, before] of oldById) {
    const after = newById.get(id);
    if (after && JSON.stringify(before) !== JSON.stringify(after)) {
      changed.push({ id, before, after });
    }
  }

  return { added, removed, changed };
}

/**
 * Load a template, enforcing tenant ownership.
 * Pass tenantId=null to skip the ownership check (internal-only callers).
 *
 * @param {string}      templateId
 * @param {string|null} [tenantId]
 * @returns {Promise<{ id, task, tasks, tenantId, createdAt }|null>}
 */
export async function getTemplate(templateId, tenantId = null) {
  const raw = await redis.hgetall(TEMPLATE_PREFIX + templateId);
  if (!raw || Object.keys(raw).length === 0) return null;

  const ownerTenantId = raw.tenantId || null;

  if (tenantId !== null && ownerTenantId !== null && ownerTenantId !== tenantId) {
    throw new TemplateTenantMismatchError(
      `Template "${templateId}" does not belong to tenant "${tenantId}".`
    );
  }

  return {
    id:        templateId,
    tenantId:  ownerTenantId,
    task:      raw.task,
    tasks:     JSON.parse(raw.tasks),
    version:   Number(raw.version ?? 1),
    createdAt: Number(raw.createdAt),
  };
}
