/**
 * tests/sandbox-stream-args.test.js
 *
 * With DOCKER_HOST set, runInSandbox must use the stream transport: no
 * --volume anywhere, worktree sent as tar on stdin without .git, tmpfs
 * worktree, hardening flags intact, and a timed-out run is killed remotely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileSync = vi.fn((cmd, args) => {
  if (cmd === 'tar') return Buffer.from('TAR');
  return Buffer.from('');                       // docker info / image inspect / rm
});
const spawnSync = vi.fn(() => ({ status: 0, stdout: Buffer.from('hello'), stderr: Buffer.alloc(0) }));
const execSync = vi.fn(() => Buffer.from('RAN ON HOST'));
vi.mock('child_process', () => ({ execFileSync, execSync, spawnSync }));
vi.mock('../engine/usage-recorder.js', () => ({
  recordUsageEvent: vi.fn(), EVENT_TYPES: { SANDBOX_MINUTES: 'sandbox_minutes' },
}));

const KEYS = ['DOCKER_HOST', 'AEGIS_SANDBOX_MODE', 'AEGIS_SANDBOX_TRANSPORT', 'CI'];
const saved = {};

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.DOCKER_HOST = 'tcp://runner.invalid:2376';
  vi.resetModules();
  execSync.mockClear(); spawnSync.mockClear(); execFileSync.mockClear();
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('stream transport (remote runner)', () => {
  it('mounts nothing, excludes .git, hardens the container', async () => {
    const { runInSandbox, getSandboxCapabilities } = await import('../engine/sandbox.js');
    const r = runInSandbox('echo hello', '/tmp', '/app');
    expect(r).toEqual({ success: true, output: 'hello' });
    expect(getSandboxCapabilities().transport).toBe('stream');

    const [bin, args, o] = spawnSync.mock.calls[0];
    expect(bin).toBe('docker');
    expect(args).not.toContain('--volume');
    expect(args).not.toContain('-v');
    expect(args).toEqual(expect.arrayContaining([
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ]));
    expect(args.some(a => a.startsWith('/tmp:size=') && a.includes('mode=1777'))).toBe(true);
    expect(o.input.toString()).toBe('TAR');

    const tarCall = execFileSync.mock.calls.find(c => c[0] === 'tar');
    expect(tarCall[1]).toContain('--exclude=.git');
    expect(execSync).not.toHaveBeenCalled();
  });

  it('ignores AEGIS_SANDBOX_TRANSPORT=bind when a remote runner is set', async () => {
    process.env.AEGIS_SANDBOX_TRANSPORT = 'bind';
    const { getSandboxCapabilities } = await import('../engine/sandbox.js');
    expect(getSandboxCapabilities().transport).toBe('stream');
  });

  it('kills the remote container on timeout', async () => {
    spawnSync.mockReturnValueOnce({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    const { runInSandbox } = await import('../engine/sandbox.js');
    const r = runInSandbox('sleep 99', '/tmp', '/app');
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/Sandbox timeout/);
    expect(execFileSync.mock.calls.some(c => c[0] === 'docker' && c[1][0] === 'rm' && c[1][1] === '-f')).toBe(true);
  });

  it('propagates non-zero exit', async () => {
    spawnSync.mockReturnValueOnce({ status: 3, stdout: Buffer.from('boom'), stderr: Buffer.alloc(0) });
    const { runInSandbox } = await import('../engine/sandbox.js');
    expect(runInSandbox('exit 3', '/tmp', '/app')).toEqual({ success: false, output: 'boom' });
  });
});
