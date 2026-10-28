#!/usr/bin/env node
/**
 * scripts/compliance-check.js — pre-launch compliance gate
 *
 *   npm run compliance:check
 *
 * Fails (exit 1) until the human-only items are signed off:
 *   1. every `operatorConfirm` field in compliance/subprocessors.json has a
 *      matching entry in that subprocessor's `confirmed` map
 *      (e.g. "confirmed": { "providerRetention": "2026-11-02 verified vs OpenAI DPA, A. Patel" })
 *   2. counsel has reviewed the legal pages: compliance/launch-signoff.json has
 *      `counselReviewedAt` and the "DRAFT" banners are gone from landing/*.html
 * SOC 2 is reported for information only (a roadmap, not a certification).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const subs = JSON.parse(readFileSync(join(root, 'compliance/subprocessors.json'), 'utf-8'));
for (const s of subs.subprocessors) {
  for (const field of s.operatorConfirm || []) {
    if (!s.confirmed?.[field]) problems.push(`subprocessor "${s.id}": "${field}" not confirmed against real contract/deployment (add to "confirmed")`);
  }
}

const signoffPath = join(root, 'compliance/launch-signoff.json');
const signoff = existsSync(signoffPath) ? JSON.parse(readFileSync(signoffPath, 'utf-8')) : {};
if (!signoff.counselReviewedAt) problems.push('counsel review not recorded (set "counselReviewedAt" + "reviewedBy" in compliance/launch-signoff.json)');
for (const page of ['dpa', 'privacy', 'security', 'terms']) {
  if (/DRAFT\s+—/.test(readFileSync(join(root, `landing/${page}.html`), 'utf-8'))) {
    problems.push(`landing/${page}.html still carries the DRAFT banner (remove after counsel approval)`);
  }
}

console.log('SOC 2: roadmap only, not certified (docs-site/docs/soc2-roadmap.md); pages must not claim certification.');
if (problems.length) {
  console.error('\nCompliance launch check FAILED:\n' + problems.map((p) => ` - ${p}`).join('\n'));
  process.exit(1);
}
console.log('Compliance launch check passed.');
