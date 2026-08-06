/**
 * engine/git-remote.js — Remote push and PR/MR creation
 *
 * Adds the two missing pieces called out in the gap analysis:
 *   1. Push the workflow branch (or merged base branch) to the configured
 *      remote after finaliseWorkflow() succeeds.
 *   2. Open a Pull Request (GitHub) or Merge Request (GitLab) against the
 *      configured target branch.
 *
 * Environment variables
 * ─────────────────────
 *   AEGIS_GIT_REMOTE          Remote name or URL to push to. When unset, push
 *                              is skipped entirely (local-only mode).
 *                              Examples: "origin", "https://github.com/org/repo"
 *
 *   AEGIS_GIT_PUSH_BRANCH     Branch that is pushed after a successful merge.
 *                              Defaults to "aegis-tenant/<tenantId>" so the
 *                              merged tenant base is what lands on the remote.
 *                              Set to "__workflow__" to push the per-workflow
 *                              branch instead (useful for review-before-merge
 *                              workflows).
 *
 *   AEGIS_PR_PROVIDER         "github" | "gitlab" | "bitbucket" | "none" (default: "none")
 *                              When "none" push happens but no PR is opened.
 *
 *   AEGIS_PR_REPO             owner/repo (GitHub), numeric project ID (GitLab),
 *                              or workspace/repo_slug (Bitbucket). Required
 *                              when provider is not "none".
 *
 *   AEGIS_PR_TARGET_BRANCH    Branch the PR/MR should target (default: "main").
 *
 *   AEGIS_PR_TOKEN            Personal access token with repo + PR write scope.
 *                              For Bitbucket, a repository/workspace access
 *                              token or OAuth token (sent as a Bearer token).
 *
 *   AEGIS_GITHUB_API_URL      Override for GitHub Enterprise
 *                              (default: "https://api.github.com")
 *
 *   AEGIS_GITLAB_API_URL      Override for self-hosted GitLab
 *                              (default: "https://gitlab.com/api/v4")
 *
 *   AEGIS_BITBUCKET_API_URL   Override for Bitbucket Server/Data Center
 *                              (default: "https://api.bitbucket.org/2.0")
 *
 * Exports
 * ───────
 *   pushBranch(branch, options?)  → Promise<void>
 *   openPullRequest(params)       → Promise<{ url: string, number: number }>
 *   pushAndOpenPR(workflowId, tenantId, mergeResult) → Promise<{ pushed, pr? }>
 */

import { spawnSync } from 'child_process';
import path from 'path';

const REPO_ROOT = path.resolve(process.env.AEGIS_REPO_ROOT ?? process.cwd());

// ─── Config helpers ───────────────────────────────────────────────────────────

function cfg(key, fallback = '') {
  return (process.env[key] ?? fallback).trim();
}

function githubApiBase() {
  return cfg('AEGIS_GITHUB_API_URL', 'https://api.github.com');
}

function gitlabApiBase() {
  return cfg('AEGIS_GITLAB_API_URL', 'https://gitlab.com/api/v4');
}

function bitbucketApiBase() {
  return cfg('AEGIS_BITBUCKET_API_URL', 'https://api.bitbucket.org/2.0');
}

// ─── Low-level git push ───────────────────────────────────────────────────────

/**
 * Push `branch` to the configured remote.
 *
 * @param {string} branch     Local branch ref to push.
 * @param {{ force?: boolean, setUpstream?: boolean }} [opts]
 * @throws {Error} when AEGIS_GIT_REMOTE is not set or git push fails.
 */
export async function pushBranch(branch, opts = {}) {
  const remote = cfg('AEGIS_GIT_REMOTE');
  if (!remote) {
    throw new Error(
      'AEGIS_GIT_REMOTE is not configured — cannot push branch. ' +
      'Set it to a remote name (e.g. "origin") or a full remote URL.',
    );
  }

  const args = ['push'];
  if (opts.force)       args.push('--force-with-lease');
  if (opts.setUpstream) args.push('--set-upstream');
  args.push(remote, `${branch}:${branch}`);

  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(
      `git push failed for branch "${branch}" → remote "${remote}": ` +
      (result.stderr ?? '').trim(),
    );
  }
}

// ─── PR / MR creation ─────────────────────────────────────────────────────────

/**
 * Open a Pull Request (GitHub) or Merge Request (GitLab).
 *
 * @param {{ title: string, body: string, head: string, base?: string }} params
 * @returns {Promise<{ url: string, number: number }>}
 */
export async function openPullRequest({ title, body, head, base }) {
  const provider    = cfg('AEGIS_PR_PROVIDER', 'none').toLowerCase();
  const targetBranch = base ?? cfg('AEGIS_PR_TARGET_BRANCH', 'main');
  const token       = cfg('AEGIS_PR_TOKEN');
  const repo        = cfg('AEGIS_PR_REPO');

  if (provider === 'none') {
    return { url: '', number: 0 };
  }

  if (!token) throw new Error('AEGIS_PR_TOKEN is required to open PRs/MRs.');
  if (!repo)  throw new Error('AEGIS_PR_REPO is required to open PRs/MRs.');

  if (provider === 'github') {
    return _openGitHubPR({ title, body, head, base: targetBranch, repo, token });
  }

  if (provider === 'gitlab') {
    return _openGitLabMR({ title, body, head, base: targetBranch, repo, token });
  }

  if (provider === 'bitbucket') {
    return _openBitbucketPR({ title, body, head, base: targetBranch, repo, token });
  }

  throw new Error(`Unknown AEGIS_PR_PROVIDER "${provider}". Valid values: github, gitlab, bitbucket, none.`);
}

async function _openGitHubPR({ title, body, head, base, repo, token }) {
  const url = `${githubApiBase()}/repos/${repo}/pulls`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:        'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ title, body, head, base }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub PR creation failed (HTTP ${res.status}): ${detail}`);
  }

  const data = await res.json();
  return { url: data.html_url, number: data.number };
}

async function _openGitLabMR({ title, body, head, base, repo, token }) {
  const url = `${gitlabApiBase()}/projects/${encodeURIComponent(repo)}/merge_requests`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'PRIVATE-TOKEN': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      description:          body,
      source_branch:        head,
      target_branch:        base,
      remove_source_branch: false,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitLab MR creation failed (HTTP ${res.status}): ${detail}`);
  }

  const data = await res.json();
  return { url: data.web_url, number: data.iid };
}

async function _openBitbucketPR({ title, body, head, base, repo, token }) {
  const url = `${bitbucketApiBase()}/repositories/${repo}/pullrequests`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      description: body,
      source: { branch: { name: head } },
      destination: { branch: { name: base } },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Bitbucket PR creation failed (HTTP ${res.status}): ${detail}`);
  }

  const data = await res.json();
  return { url: data.links?.html?.href, number: data.id };
}

// ─── Composite helper used by the worker ─────────────────────────────────────

/**
 * Called after `finaliseWorkflow()` returns `{ merged: true }`.
 *
 * Determines which branch to push (workflow branch or tenant base), pushes it,
 * then optionally opens a PR/MR.  All failures are re-thrown so the caller can
 * record them without hiding the original merge success.
 *
 * @param {string} workflowId
 * @param {string} tenantId
 * @param {{ merged: boolean, resolvedVia?: string }} mergeResult
 * @returns {Promise<{ pushed: boolean, pr?: { url: string, number: number } }>}
 */
export async function pushAndOpenPR(workflowId, tenantId, mergeResult) {
  const remote = cfg('AEGIS_GIT_REMOTE');
  if (!remote) {
    // Remote not configured — local-only mode, nothing to do.
    return { pushed: false };
  }

  const pushBranchEnv = cfg('AEGIS_GIT_PUSH_BRANCH', '');
  const branchToPush  =
    pushBranchEnv === '__workflow__'
      ? `aegis/${tenantId}/${workflowId}`
      : `aegis-tenant/${tenantId}`;

  await pushBranch(branchToPush, { setUpstream: true });

  const provider = cfg('AEGIS_PR_PROVIDER', 'none').toLowerCase();
  if (provider === 'none') {
    return { pushed: true };
  }

  const targetBranch = cfg('AEGIS_PR_TARGET_BRANCH', 'main');
  const resolvedNote = mergeResult.resolvedVia === 'rebase'
    ? '\n\n> ℹ️ Conflicts were resolved automatically via `git rebase`.'
    : '';

  const pr = await openPullRequest({
    title: `Aegis: workflow ${workflowId}`,
    body:  `Automated changes produced by Aegis workflow \`${workflowId}\` for tenant \`${tenantId}\`.${resolvedNote}`,
    head:  branchToPush,
    base:  targetBranch,
  });

  return { pushed: true, pr };
}
