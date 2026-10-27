/**
 * tests/sandbox-remote-failclosed.test.js
 *
 * engine/sandbox.js — when DOCKER_HOST (remote runner) is set and unreachable,
 * runInSandbox must block, even with AEGIS_SANDBOX_MODE=local / CI=true set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileSync = vi.fn(() => { throw new Error('daemon unreachable'); });
const execSync = vi.fn(() => Buffer.from('RAN ON HOST'));
vi.mock('child_process', () => ({ execFileSync, execSync }));
vi.mock('../engine/usage-recorder.js', () => ({
  recordUsageEvent: vi.fn(), EVENT_TYPES: { SANDBOX_MINUTES: 'sandbox_minutes' },
}));

const KEYS = ['DOCKER_HOST', 'AEGIS_SANDBOX_MODE', 'AEGIS_SANDBOX_DISABLE', 'CI'];
const saved = {};

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  vi.resetModules();
  execSync.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});

describe('remote runner fail-closed', () => {
  for (const [name, env] of [
    ['AEGIS_SANDBOX_MODE=local', { AEGIS_SANDBOX_MODE: 'local' }],
    ['AEGIS_SANDBOX_DISABLE=true', { AEGIS_SANDBOX_DISABLE: 'true' }],
    ['CI=true', { CI: 'true' }],
  ]) {
    it(`blocks instead of running on the host with ${name}`, async () => {
      process.env.DOCKER_HOST = 'tcp://runner.invalid:2376';
      Object.assign(process.env, env);
      const { runInSandbox, getSandboxCapabilities } = await import('../engine/sandbox.js');
      const r = runInSandbox('echo hi', '/tmp', '/app');
      expect(r.success).toBe(false);
      expect(r.output).toMatch(/DOCKER_HOST is set/);
      expect(execSync).not.toHaveBeenCalled();
      expect(getSandboxCapabilities().mode).toBe('blocked');
    });
  }

  it('without DOCKER_HOST the local opt-in still works (dev unchanged)', async () => {
    process.env.AEGIS_SANDBOX_MODE = 'local';
    const { runInSandbox } = await import('../engine/sandbox.js');
    const r = runInSandbox('echo hi', '/tmp', '/app');
    expect(r).toEqual({ success: true, output: 'RAN ON HOST' });
  });
});
