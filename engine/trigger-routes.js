/**
 * engine/trigger-routes.js — Inbound triggers (Slack, Jira) + tenant trigger config
 *
 *   POST /webhooks/slack/command        Slack slash command (/aegis <task> | /aegis link <code>)
 *   POST /webhooks/jira/:tenantId       Jira webhook / Automation (label trigger)
 *   GET    /tenants/:id/triggers        config
 *   PUT    /tenants/:id/triggers        { githubLabel?, jiraLabel?, jiraProjects?, slackAllowedUsers? }
 *   POST   /tenants/:id/triggers/slack/link-code     → { code } (run `/aegis link <code>` in Slack)
 *   DELETE /tenants/:id/triggers/slack               unlink workspace
 *   POST   /tenants/:id/triggers/jira/secret         → { secret, url } (shown once; rotates)
 *   DELETE /tenants/:id/triggers/jira                remove secret (disables Jira trigger)
 *
 * GitHub issue-label events arrive on /webhooks/github-app (repo-routes.js).
 *
 * Mount:
 *   app.use('/webhooks', triggerWebhookRouter);   // BEFORE webhookRouter (raw body)
 *   app.use(triggerRouter);
 */

import express from 'express';
import { requireApiKey, requirePermission, assertTenantAccess, auditActor } from '../middleware/auth.js';
import { recordAuditEvent } from './audit-log.js';
import {
  getTriggerConfig, setTriggerConfig, createSlackLinkCode, consumeSlackLinkCode, tenantForSlackTeam,
  unlinkSlack, rotateJiraSecret, getJiraSecret, deleteJiraSecret, claimOnce,
} from './trigger-store.js';
import {
  verifySlackSignature, verifyJiraRequest, parseSlackCommand, parseJiraEvent,
  buildSlackTask, buildJiraTask, launchTrigger,
} from './inbound-triggers.js';

export const triggerWebhookRouter = express.Router();
export const triggerRouter = express.Router();

const raw = express.raw({ type: '*/*', limit: '1mb' });
const ephemeral = (text) => ({ response_type: 'ephemeral', text });

const HELP = [
  '*Aegis* — `/aegis <describe the change>` runs a workflow on your linked repo.',
  '`/aegis link <code>` links this workspace to your Aegis tenant (get a code from the Aegis API or dashboard).',
].join('\n');

// ─── Slack ───────────────────────────────────────────────────────────────────

triggerWebhookRouter.post('/slack/command', raw, async (req, res) => {
  const secret = (process.env.AEGIS_SLACK_SIGNING_SECRET ?? '').trim();
  if (!verifySlackSignature(req.body, req.get('x-slack-signature'), req.get('x-slack-request-timestamp'), secret)) {
    return res.status(401).end();
  }
  const cmd = parseSlackCommand(req.body);

  try {
    if (!cmd.text || cmd.text === 'help') return res.json(ephemeral(HELP));

    const [first, second] = cmd.text.split(/\s+/);
    if (first === 'link') {
      const tenantId = await consumeSlackLinkCode((second ?? '').toUpperCase(), cmd.teamId);
      if (!tenantId) return res.json(ephemeral('Invalid or expired link code.'));
      recordAuditEvent(tenantId, {
        actorId: `slack:${cmd.userId}`, actorType: 'trigger', action: 'trigger.slack.linked',
        resourceType: 'tenant', resourceId: tenantId, detail: { teamId: cmd.teamId },
      }).catch(() => {});
      return res.json(ephemeral('✅ This Slack workspace is linked. Try `/aegis <describe the change>`.'));
    }

    const tenantId = await tenantForSlackTeam(cmd.teamId);
    if (!tenantId) return res.json(ephemeral('This workspace is not linked to an Aegis tenant. Run `/aegis link <code>`.'));

    const cfg = await getTriggerConfig(tenantId);
    if (cfg.slackAllowedUsers.length && !cfg.slackAllowedUsers.includes(cmd.userId)) {
      return res.json(ephemeral('You are not allowed to run Aegis workflows for this tenant.'));
    }
    if (cmd.triggerId && !(await claimOnce(`slack:${cmd.triggerId}`, 3600))) return res.json(ephemeral('Duplicate request ignored.'));

    let task;
    try { task = buildSlackTask(cmd.text); }
    catch { return res.json(ephemeral('Blocked: the text looks like a prompt-injection attempt. Rephrase the request.')); }

    const origin = { type: 'slack', responseUrl: cmd.responseUrl, expiresAt: Date.now() + 25 * 60_000 };
    const r = await launchTrigger({ tenantId, source: 'slack', task, origin, ref: `${cmd.teamId}/${cmd.userId}` });
    return res.json(ephemeral(r.accepted ? '🛡️ Request received — planning now. I\'ll reply here with the workflow ID.' : `❌ ${r.reason}`));
  } catch (err) {
    console.error('[webhook/slack]', err);
    return res.json(ephemeral('Something went wrong. Try again.'));
  }
});

// ─── Jira ────────────────────────────────────────────────────────────────────

triggerWebhookRouter.post('/jira/:tenantId', raw, async (req, res) => {
  const { tenantId } = req.params;
  try {
    const secret = await getJiraSecret(tenantId).catch(() => null);
    if (!verifyJiraRequest(req.body, req.headers, secret)) return res.status(401).end();

    let payload;
    try { payload = JSON.parse(req.body.toString('utf-8')); } catch { return res.status(400).end(); }

    const cfg = await getTriggerConfig(tenantId);
    const jira = parseJiraEvent(payload, cfg.jiraLabel, cfg.jiraProjects);
    if (!jira) return res.status(200).json({ accepted: false, reason: 'not a trigger event' });

    const delivery = req.get('x-atlassian-webhook-identifier');
    if (delivery && !(await claimOnce(`jira:${delivery}`, 86400))) return res.status(200).json({ accepted: false, reason: 'duplicate delivery' });
    if (!(await claimOnce(`jira-issue:${tenantId}:${jira.key}`, 900))) return res.status(200).json({ accepted: false, reason: 'already running for this ticket' });

    let task;
    try { task = buildJiraTask(jira); }
    catch { return res.status(200).json({ accepted: false, reason: 'blocked' }); }

    const r = await launchTrigger({ tenantId, source: 'jira', task, ref: jira.key });
    return res.status(r.accepted ? 202 : 402).json(r);
  } catch (err) {
    console.error('[webhook/jira]', err);
    return res.status(500).end();
  }
});

// ─── Tenant config (admin) ───────────────────────────────────────────────────

const guard = [requireApiKey, requirePermission('tenant.admin')];
const audit = (req, tenantId, action, detail = {}) =>
  recordAuditEvent(tenantId, {
    ...auditActor(req), action, resourceType: 'tenant', resourceId: tenantId, detail,
  }).catch(err => console.error(`[audit] ${action}`, err));

triggerRouter.get('/tenants/:id/triggers', ...guard, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try { res.json(await getTriggerConfig(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

triggerRouter.put('/tenants/:id/triggers', express.json(), ...guard, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try {
    const cfg = await setTriggerConfig(req.params.id, req.body ?? {});
    audit(req, req.params.id, 'trigger.config.updated', Object.keys(req.body ?? {}));
    res.json(cfg);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

triggerRouter.post('/tenants/:id/triggers/slack/link-code', ...guard, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try { res.json({ code: await createSlackLinkCode(req.params.id), expiresInSeconds: 900, usage: '/aegis link <code>' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

triggerRouter.delete('/tenants/:id/triggers/slack', ...guard, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try { await unlinkSlack(req.params.id); audit(req, req.params.id, 'trigger.slack.unlinked'); res.json({ status: 'unlinked' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

triggerRouter.post('/tenants/:id/triggers/jira/secret', ...guard, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try {
    const secret = await rotateJiraSecret(req.params.id);
    audit(req, req.params.id, 'trigger.jira.secret_rotated');
    const base = (process.env.AEGIS_PUBLIC_URL ?? '').replace(/\/$/, '');
    res.json({ secret, url: `${base}/webhooks/jira/${req.params.id}`, note: 'Shown once. Use as the webhook secret (X-Hub-Signature) or as the X-Aegis-Token header.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

triggerRouter.delete('/tenants/:id/triggers/jira', ...guard, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try { await deleteJiraSecret(req.params.id); audit(req, req.params.id, 'trigger.jira.disabled'); res.json({ status: 'disabled' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
