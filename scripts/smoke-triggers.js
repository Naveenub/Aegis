#!/usr/bin/env node
/**
 * scripts/smoke-triggers.js — Live check of a deployed Aegis' inbound triggers.
 * Non-mutating by default: only auth rejections, "not a trigger" no-ops and a Slack `help`.
 *
 *   BASE_URL=https://aegis.example.com \
 *   AEGIS_SLACK_SIGNING_SECRET=...  AEGIS_GITHUB_MARKETPLACE_WEBHOOK_SECRET=... \
 *   TENANT=acme JIRA_TOKEN=...  AEGIS_API_KEY=... \
 *   node scripts/smoke-triggers.js
 *
 * Each section runs only if its inputs are set. Exit code 1 on any failure.
 * `--fire-jira` additionally sends a real trigger event (STARTS A WORKFLOW).
 */
import crypto from 'crypto';

const { BASE_URL, TENANT, JIRA_TOKEN, AEGIS_API_KEY } = process.env;
const SLACK = process.env.AEGIS_SLACK_SIGNING_SECRET, MKT = process.env.AEGIS_GITHUB_MARKETPLACE_WEBHOOK_SECRET;
if (!BASE_URL) { console.error('BASE_URL is required'); process.exit(2); }
const base = BASE_URL.replace(/\/$/, '');
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!ok) failed++; };
const skip = (name, why) => console.log(`SKIP  ${name}  (${why})`);

async function slack(text, secret) {
  const body = new URLSearchParams({ team_id: 'TSMOKE', user_id: 'USMOKE', channel_id: 'CSMOKE', text, trigger_id: crypto.randomUUID() }).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return fetch(`${base}/webhooks/slack/command`, { method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-signature': sig, 'x-slack-request-timestamp': ts } });
}

if (SLACK) {
  check('slack: wrong signature → 401', (await slack('help', 'wrong-secret')).status === 401);
  const r = await slack('help', SLACK);
  check('slack: signed `help` → usage text', r.status === 200 && (await r.json()).text?.includes('/aegis'), `HTTP ${r.status}`);
} else skip('slack', 'AEGIS_SLACK_SIGNING_SECRET not set');

if (TENANT && JIRA_TOKEN) {
  const url = `${base}/webhooks/jira/${TENANT}`;
  const post = (body, headers) => fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  check('jira: no token → 401', (await post({}, {})).status === 401);
  const r = await post({ webhookEvent: 'jira:issue_created', issue: { key: 'SMOKE-1', fields: { labels: ['unrelated'] } } }, { 'x-aegis-token': JIRA_TOKEN });
  check('jira: valid token, non-trigger event → accepted:false', r.status === 200 && (await r.json()).accepted === false, `HTTP ${r.status}`);
  if (process.argv.includes('--fire-jira')) {
    const f = await post({ webhookEvent: 'jira:issue_created', issue: { key: 'SMOKE-2', fields: { labels: [process.env.AEGIS_TRIGGER_LABEL || 'aegis'], summary: 'Smoke test: add a comment to README', description: 'Smoke test.' } } }, { 'x-aegis-token': JIRA_TOKEN });
    check('jira: trigger event → 202', f.status === 202, `HTTP ${f.status} — a workflow was started`);
  }
} else skip('jira', 'TENANT / JIRA_TOKEN not set');

if (MKT) {
  const send = (body, sig) => fetch(`${base}/webhooks/github-marketplace`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'marketplace_purchase', 'x-github-delivery': crypto.randomUUID(), 'x-hub-signature-256': sig } });
  const body = JSON.stringify({ action: 'pending_change' });
  check('marketplace: bad signature → 401', (await send(body, 'sha256=00')).status === 401);
  const r = await send(body, 'sha256=' + crypto.createHmac('sha256', MKT).update(body).digest('hex'));
  check('marketplace: signed pending_change → ignored', r.status === 200 && (await r.json()).ignored === true, `HTTP ${r.status}`);
} else skip('marketplace', 'AEGIS_GITHUB_MARKETPLACE_WEBHOOK_SECRET not set');

if (TENANT && AEGIS_API_KEY) {
  const r = await fetch(`${base}/tenants/${TENANT}/triggers`, { headers: { 'x-api-key': AEGIS_API_KEY } });
  const c = r.ok ? await r.json() : {};
  check('config: readable', r.ok, `HTTP ${r.status}`);
  if (r.ok) {
    console.log('INFO  github issues permission :', c.githubIssues?.issues ?? 'n/a (no App installation)', c.githubIssues?.settingsUrl ? `— approve at ${c.githubIssues.settingsUrl}` : '');
    console.log('INFO  label trigger / comments :', c.githubIssues?.labelTrigger ?? 'n/a', '/', c.githubIssues?.statusComments ?? 'n/a');
    console.log('INFO  slack linked / bot token :', Boolean(c.slackTeamId), '/', c.slackBot);
    console.log('INFO  jira secret / write-back :', c.jiraConfigured, '/', c.jiraWriteBack);
    if (c.lastOriginProblem) console.log('WARN  last reporting problem   :', c.lastOriginProblem.detail);
  }
} else skip('config', 'TENANT / AEGIS_API_KEY not set');

process.exit(failed ? 1 : 0);
