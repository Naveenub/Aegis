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
 *   aegis:template:{id}   HASH — { tenantId, task, tasks (JSON), createdAt }
 */

import IORedis from 'ioredis';
import crypto from 'crypto';

const redis = new IORedis();

const TEMPLATE_PREFIX = 'aegis:template:';

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

  await redis.hset(TEMPLATE_PREFIX + templateId, {
    tenantId:  tenantId ?? '',
    task,
    tasks:     JSON.stringify(tasks),
    createdAt: Date.now().toString(),
  });

  return templateId;
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
    createdAt: Number(raw.createdAt),
  };
}
