/**
 * engine/trigger-store.js — Inbound trigger state (Redis)
 *
 *   aegis:trigger:cfg:{tenantId}      Hash  githubLabel, jiraLabel, jiraProjects (csv), slackAllowedUsers (csv),
 *                                           slackTeamId, jiraSecretHash
 *   aegis:trigger:slack-team:{teamId} String tenantId   (one Slack workspace → one tenant)
 *   aegis:trigger:slack-link:{code}   String tenantId   (single-use, 15 min)
 *   aegis:trigger:jira-secret:{tid}   String secret     (HMAC key / shared token for Jira webhooks)
 *   aegis:trigger:dedup:{key}         String "1"        (TTL)
 *   aegis:trigger:origin:{workflowId} String JSON       (where to report back, 24 h)
 */

import IORedis from 'ioredis';
import { randomBytes } from 'crypto';
import { assertTenantId } from './tenant.js';

const redis = new IORedis(process.env.REDIS_URL || undefined, {
  lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
  connectTimeout: 3000, retryStrategy: () => null,
});
redis.on('error', () => {});

const CFG   = (t) => `aegis:trigger:cfg:${t}`;
const TEAM  = (id) => `aegis:trigger:slack-team:${id}`;
const LINK  = (c) => `aegis:trigger:slack-link:${c}`;
const JSEC  = (t) => `aegis:trigger:jira-secret:${t}`;
const DEDUP = (k) => `aegis:trigger:dedup:${k}`;
const ORIG  = (w) => `aegis:trigger:origin:${w}`;

const csv = (s) => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);

export async function getTriggerConfig(tenantId) {
  assertTenantId(tenantId);
  const h = (await redis.hgetall(CFG(tenantId))) ?? {};
  return {
    githubLabel: h.githubLabel || process.env.AEGIS_TRIGGER_LABEL || 'aegis',
    jiraLabel: h.jiraLabel || process.env.AEGIS_TRIGGER_LABEL || 'aegis',
    jiraProjects: csv(h.jiraProjects),
    slackAllowedUsers: csv(h.slackAllowedUsers),
    slackTeamId: h.slackTeamId || null,
    jiraConfigured: Boolean(await redis.get(JSEC(tenantId))),
  };
}

const LABEL_RE = /^[\w .:/-]{1,50}$/;

export async function setTriggerConfig(tenantId, patch = {}) {
  assertTenantId(tenantId);
  const out = {};
  for (const k of ['githubLabel', 'jiraLabel']) {
    if (patch[k] === undefined) continue;
    if (typeof patch[k] !== 'string' || !LABEL_RE.test(patch[k])) throw new Error(`\`${k}\` must be 1-50 chars (letters, digits, space . : / _ -).`);
    out[k] = patch[k];
  }
  if (patch.jiraProjects !== undefined) {
    const list = Array.isArray(patch.jiraProjects) ? patch.jiraProjects : csv(patch.jiraProjects);
    if (!list.every(p => /^[A-Z][A-Z0-9_]{1,19}$/.test(p))) throw new Error('`jiraProjects` must be Jira project keys (e.g. ["APP","OPS"]).');
    out.jiraProjects = list.join(',');
  }
  if (patch.slackAllowedUsers !== undefined) {
    const list = Array.isArray(patch.slackAllowedUsers) ? patch.slackAllowedUsers : csv(patch.slackAllowedUsers);
    if (!list.every(u => /^[UW][A-Z0-9]{2,20}$/.test(u))) throw new Error('`slackAllowedUsers` must be Slack user IDs (e.g. ["U012ABC"]).');
    out.slackAllowedUsers = list.join(',');
  }
  if (Object.keys(out).length) await redis.hset(CFG(tenantId), out);
  return getTriggerConfig(tenantId);
}

// ── Slack workspace link (proved by a signed slash command, never by a claimed id) ──

export async function createSlackLinkCode(tenantId) {
  assertTenantId(tenantId);
  const code = randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
  await redis.set(LINK(code), tenantId, 'EX', 900);
  return code;
}

/** Consume a code; bind teamId → tenant. Throws code=TEAM_TAKEN if another tenant owns the team. */
export async function consumeSlackLinkCode(code, teamId) {
  if (!/^[A-F0-9]{10}$/.test(String(code))) return null;
  const tenantId = await redis.getdel(LINK(code));
  if (!tenantId) return null;
  if (!/^[A-Z0-9]{2,20}$/.test(String(teamId))) return null;
  const claimed = await redis.set(TEAM(teamId), tenantId, 'NX');
  if (!claimed && (await redis.get(TEAM(teamId))) !== tenantId) {
    const e = new Error('This Slack workspace is already linked to another tenant.');
    e.code = 'TEAM_TAKEN';
    throw e;
  }
  const prev = await redis.hget(CFG(tenantId), 'slackTeamId');
  if (prev && prev !== teamId) await redis.del(TEAM(prev));
  await redis.hset(CFG(tenantId), { slackTeamId: teamId });
  return tenantId;
}

export async function tenantForSlackTeam(teamId) {
  return (await redis.get(TEAM(String(teamId)))) ?? null;
}

export async function unlinkSlack(tenantId) {
  assertTenantId(tenantId);
  const team = await redis.hget(CFG(tenantId), 'slackTeamId');
  if (team) await redis.del(TEAM(team));
  await redis.hdel(CFG(tenantId), 'slackTeamId');
}

// ── Jira secret ──

/** Generate (or rotate) the tenant's Jira secret. Returned once; configure it in Jira. */
export async function rotateJiraSecret(tenantId) {
  assertTenantId(tenantId);
  const secret = randomBytes(32).toString('hex');
  await redis.set(JSEC(tenantId), secret);
  return secret;
}
export async function getJiraSecret(tenantId) {
  assertTenantId(tenantId);
  return (await redis.get(JSEC(tenantId))) ?? null;
}
export async function deleteJiraSecret(tenantId) {
  assertTenantId(tenantId);
  await redis.del(JSEC(tenantId));
}

// ── Dedup + origin ──

/** true the first time `key` is seen within ttlSec. */
export async function claimOnce(key, ttlSec = 3600) {
  return (await redis.set(DEDUP(key), '1', 'EX', ttlSec, 'NX')) === 'OK';
}

export async function saveOrigin(workflowId, origin) {
  await redis.set(ORIG(workflowId), JSON.stringify(origin), 'EX', 86400);
}
export async function loadOrigin(workflowId) {
  const raw = await redis.get(ORIG(workflowId));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
