/**
 * tests/integration/system/docker-sandbox-stream.system.test.js
 *
 * SYSTEM TEST — requires a live Docker daemon (skipped when unreachable).
 *
 * Covers the "stream" transport used with a remote/sidecar daemon: the
 * worktree reaches the container as a tar on stdin, nothing is bind-mounted,
 * and container-side writes never touch the host copy.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function isDockerReachable() {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

describe('System: Docker sandbox — stream transport', () => {
  let skip = false;
  let tmpRoot;
  let worktree;
  let sandbox;

  beforeAll(async () => {
    skip = !isDockerReachable();
    if (skip) return;

    tmpRoot  = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-sandbox-stream-'));
    worktree = path.join(tmpRoot, 'worktree');
    fs.mkdirSync(path.join(worktree, '.git'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git', 'config'), 'url=https://token@example.com/r.git');
    fs.writeFileSync(path.join(worktree, 'in.txt'), 'from-host');

    process.env.AEGIS_SANDBOX_TIMEOUT_MS = '20000';
    process.env.AEGIS_SANDBOX_TRANSPORT = 'stream';
    vi.resetModules();
    sandbox = await import('../../../engine/sandbox.js');
  });

  afterAll(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('delivers the worktree to the container without a bind mount', () => {
    if (skip) return;
    const result = sandbox.runInSandbox('cat in.txt', worktree, tmpRoot);
    expect(result.success).toBe(true);
    expect(result.output).toContain('from-host');
  });

  it('does not ship .git into the container', () => {
    if (skip) return;
    const result = sandbox.runInSandbox('test -e .git && echo HAS_GIT || echo NO_GIT', worktree, tmpRoot);
    expect(result.output).toContain('NO_GIT');
  });

  it('keeps container-side writes off the host', () => {
    if (skip) return;
    const result = sandbox.runInSandbox('echo x > out.txt && cat out.txt', worktree, tmpRoot);
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(worktree, 'out.txt'))).toBe(false);
  });

  it('propagates a non-zero exit status', () => {
    if (skip) return;
    expect(sandbox.runInSandbox('exit 3', worktree, tmpRoot).success).toBe(false);
  });
});
