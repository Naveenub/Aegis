/**
 * engine/rbac.js — role → permission model
 *
 * Three ordered roles; a role holds every permission of the roles below it.
 *
 *   viewer  read-only: workflows, traces, metrics, review queue
 *   member  viewer + run/cancel/resume workflows, rewind steps, resolve reviews
 *   admin   member + API keys, users, audit log, BYOK, billing actions
 *
 * Each permission maps to the MINIMUM role that holds it. Routes declare the
 * permission they need (middleware/auth.js → requirePermission); nothing
 * outside this file compares role names.
 *
 * Legacy credentials (env-var keys, key-store records created before roles
 * existed) resolve to LEGACY_ROLE = 'admin' so existing deployments behave
 * exactly as before.
 */

export const ROLES = ['viewer', 'member', 'admin'];
export const LEGACY_ROLE = 'admin';

const RANK = Object.fromEntries(ROLES.map((r, i) => [r, i + 1]));

/** permission → minimum role */
export const PERMISSIONS = {
  'workflow.run':   'member', // submit, resume, cancel, rewind, templates
  'review.resolve': 'member',
  'key.manage':     'admin',
  'user.manage':    'admin',
  'audit.read':     'admin',
  'sso.read':       'admin',
  'tenant.admin':   'admin',  // BYOK, credit checkout, billing portal
};

export const isRole = (r) => typeof r === 'string' && r in RANK;

/** Unknown role or unknown permission → false (fail closed). */
export function can(role, permission) {
  const min = PERMISSIONS[permission];
  return !!min && isRole(role) && RANK[role] >= RANK[min];
}

export const permissionsFor = (role) =>
  Object.keys(PERMISSIONS).filter((p) => can(role, p));
