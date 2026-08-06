/**
 * tests/integration/system/docker-sandbox.system.test.js
 *
 * SYSTEM TEST — requires a live Docker daemon.
 *
 * Skipped automatically when Docker is unreachable (a local dev machine
 * without Docker running). On GitHub-hosted `ubuntu-latest` / `windows-latest`
 * runners, Docker is already up and running by default — no `dind` service or
 * self-hosted runner is required. See .github/workflows/ci.yml.
 *
 * What this covers (unit tests never exercise this — engine/sandbox.js is
 * unit-mocked and explicitly excluded from unit coverage in
 * vitest.workspace.js, since the whole point of sandbox.js is to shell out to
 * a real `docker` binary):
 *   • runInSandbox() actually invokes `docker run` and returns real stdout
 *   • Network isolation — `--network none` really blocks outbound requests
 *   • Read-only rootfs — writes outside the bind-mounted worktree fail
 *   • The worktree bind mount is writable and changes are visible on the host
 *   • node_modules is bind-mounted read-only
 *   • Non-root execution — the container runs as uid 65534 (nobody), not root
 *   • Wall-clock timeout is enforced (AEGIS_SANDBOX_TIMEOUT_MS)
 *   • getSandboxCapabilities() reports mode: 'docker' when Docker is present
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── helpers ───────────────────────────────────────────────────────────────────

function isDockerReachable() {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

let tmpRoot;
let worktree;
let nodeModules;
let sandbox;

// ── suite ─────────────────────────────────────────────────────────────────────

describe('System: Docker sandbox — real container execution', () => {
  let skip = false;

  beforeAll(async () => {
    skip = !isDockerReachable();
    if (skip) {
      console.warn(
        '[system-test] Docker not reachable — skipping live sandbox tests. ' +
        'Start Docker to run these (GitHub-hosted runners have it by default).'
      );
      return;
    }

    // Fresh worktree + node_modules dir per run so tests don't collide and
    // don't touch the real repo tree.
    tmpRoot     = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-sandbox-test-'));
    worktree    = path.join(tmpRoot, 'worktree');
    nodeModules = path.join(tmpRoot, 'node_modules');
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(nodeModules, { recursive: true });

    // sandbox.js reads env + probes Docker once at import time, so set env
    // before importing and use a fresh module graph per test file run.
    process.env.AEGIS_SANDBOX_TIMEOUT_MS = process.env.AEGIS_SANDBOX_TIMEOUT_MS ?? '20000';
    sandbox = await import('../../../engine/sandbox.js');
  });

  afterEach(() => {
    if (skip) return;
    // Clean the worktree between tests, keep the directory itself.
    for (const entry of fs.readdirSync(worktree)) {
      fs.rmSync(path.join(worktree, entry), { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reports docker mode when Docker is available', () => {
    if (skip) return;
    const caps = sandbox.getSandboxCapabilities();
    expect(caps.docker).toBe(true);
    expect(caps.mode).toBe('docker');
    expect(caps.enabled).toBe(true);
    expect(caps.enforced).toBe(false);
  });

  it('runs a real command inside a container and returns its stdout', () => {
    if (skip) return;
    const result = sandbox.runInSandbox('echo hello-from-sandbox', worktree, tmpRoot);
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello-from-sandbox');
  });

  it('writes inside the bind-mounted worktree are visible on the host', () => {
    if (skip) return;
    const result = sandbox.runInSandbox(
      'echo written-in-container > out.txt',
      worktree,
      tmpRoot
    );
    expect(result.success).toBe(true);

    const hostFile = path.join(worktree, 'out.txt');
    expect(fs.existsSync(hostFile)).toBe(true);
    expect(fs.readFileSync(hostFile, 'utf-8')).toContain('written-in-container');
  });

  it('blocks outbound network access (--network none)', () => {
    if (skip) return;
    // BusyBox/alpine's wget with a short timeout; any reachable host would
    // normally resolve+connect in well under 5s, so a failure here means the
    // network really is isolated rather than the request being slow.
    const result = sandbox.runInSandbox(
      'wget -T 5 -q -O - http://example.com || echo NETWORK_BLOCKED',
      worktree,
      tmpRoot
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('NETWORK_BLOCKED');
  });

  it('enforces a read-only rootfs outside the bind mounts', () => {
    if (skip) return;
    const result = sandbox.runInSandbox(
      'touch /root-write-test 2>&1 || echo READONLY_ROOTFS',
      worktree,
      tmpRoot
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('READONLY_ROOTFS');
  });

  it('mounts node_modules read-only', () => {
    if (skip) return;
    fs.writeFileSync(path.join(nodeModules, 'marker.txt'), 'do-not-touch');
    const result = sandbox.runInSandbox(
      `test -f ${nodeModules}/marker.txt && ` +
        `(echo write-attempt > ${nodeModules}/marker.txt 2>&1 || echo NODE_MODULES_READONLY)`,
      worktree,
      tmpRoot
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('NODE_MODULES_READONLY');
  });

  it('runs as a non-root user (uid 65534 / nobody)', () => {
    if (skip) return;
    const result = sandbox.runInSandbox('id -u', worktree, tmpRoot);
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe('65534');
  });

  it('fails cleanly rather than hanging when the worktree does not exist', () => {
    if (skip) return;
    const missing = path.join(tmpRoot, 'does-not-exist');
    const result = sandbox.runInSandbox('echo unreachable', missing, tmpRoot);
    expect(result.success).toBe(false);
    expect(result.output).toContain('worktree not found');
  });

  it('enforces the wall-clock timeout on a runaway command', () => {
    if (skip) return;
    const result = sandbox.runInSandbox('sleep 30', worktree, tmpRoot);
    expect(result.success).toBe(false);
    expect(result.output.toLowerCase()).toContain('timeout');
  }, 25000);
});
