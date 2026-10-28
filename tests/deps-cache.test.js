import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const runInSandbox = vi.fn();
vi.mock('../engine/sandbox.js', () => ({ runInSandbox: (...a) => runInSandbox(...a) }));

const { ensureDeps, depsKey } = await import('../engine/deps-cache.js');
const { TOOLCHAINS, prepareToolchain, noToolchainResult } = await import('../engine/toolchains.js');

let repo;
let cache;
const write = (rel, text = '') => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const ctx = () => ({ cwd: repo, projectRoot: '/p', tenantId: 't1' });

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-dc-repo-')));
  cache = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-dc-cache-')));
  process.env.AEGIS_DEPS_CACHE_DIR = cache;
  runInSandbox.mockReset();
  runInSandbox.mockImplementation((cmd, cwd, root, tenant, opts) => {
    fs.writeFileSync(path.join(opts.rwMounts[0], 'marker'), 'x'); // pretend the install wrote something
    return { success: true, output: 'installed' };
  });
});

afterEach(() => {
  for (const d of [repo, cache]) fs.rmSync(d, { recursive: true, force: true });
  for (const k of ['AEGIS_DEPS_CACHE_DIR', 'AEGIS_SANDBOX_AUTO_DEPS', 'AEGIS_SANDBOX_PYTHON_DEPS',
    'AEGIS_SANDBOX_JAVA_DEPS', 'AEGIS_SANDBOX_ALLOW_UNSUPPORTED']) delete process.env[k];
});

describe('ensureDeps', () => {
  it('installs with network in a separate step, then serves later calls from the cache', () => {
    write('requirements.txt', 'six==1.16.0\n');
    const first = ensureDeps(TOOLCHAINS.python, ctx());

    expect(first.error).toBeUndefined();
    expect(fs.existsSync(path.join(first.dir, '.ready'))).toBe(true);
    expect(fs.existsSync(path.join(first.dir, 'marker'))).toBe(true);

    const [, installCwd, , tenant, opts] = runInSandbox.mock.calls[0];
    expect(opts.network).toBe(true);
    expect(opts.toolchain).toBe('python-deps');
    expect(opts.rwMounts).toHaveLength(1);
    expect(opts.env.AEGIS_DEPS).toBe(opts.rwMounts[0]);
    expect(tenant).toBe('t1');
    expect(installCwd).not.toBe(repo); // works on a scratch copy, never the real worktree

    expect(ensureDeps(TOOLCHAINS.python, ctx()).dir).toBe(first.dir);
    expect(runInSandbox).toHaveBeenCalledTimes(1);
  });

  it('builds a new cache when a manifest changes', () => {
    write('requirements.txt', 'six==1.16.0\n');
    const a = ensureDeps(TOOLCHAINS.python, ctx()).dir;
    write('requirements.txt', 'six==1.16.0\nidna==3.7\n');
    const b = ensureDeps(TOOLCHAINS.python, ctx()).dir;
    expect(b).not.toBe(a);
    expect(runInSandbox).toHaveBeenCalledTimes(2);
  });

  it('reports a failed install and leaves no cache behind', () => {
    write('requirements.txt', 'nope==1\n');
    runInSandbox.mockReturnValue({ success: false, output: 'ERROR: no matching distribution' });
    const r = ensureDeps(TOOLCHAINS.python, ctx());
    expect(r.dir).toBeNull();
    expect(r.error).toContain('no matching distribution');
    expect(fs.readdirSync(path.join(cache, 'python'))).toEqual([]);
  });

  it('skips Go when vendor/ is committed or the module has no requirements', () => {
    write('go.mod', 'module x\n\ngo 1.21\n');
    expect(ensureDeps(TOOLCHAINS.go, ctx()).dir).toBeNull();

    write('go.mod', 'module x\n\ngo 1.21\n\nrequire github.com/a/b v1.0.0\n');
    write('vendor/modules.txt', '# github.com/a/b v1.0.0\n');
    expect(ensureDeps(TOOLCHAINS.go, ctx()).dir).toBeNull();
    expect(runInSandbox).not.toHaveBeenCalled();

    fs.rmSync(path.join(repo, 'vendor'), { recursive: true });
    expect(ensureDeps(TOOLCHAINS.go, ctx()).dir).not.toBeNull();
    expect(runInSandbox).toHaveBeenCalledTimes(1);
  });

  it('points Gradle at the directory that contains modules-2', () => {
    write('build.gradle', '');
    const r = ensureDeps(TOOLCHAINS['java-gradle'], ctx());
    expect(path.basename(r.dir)).toBe('caches');
  });

  it('keys on manifest contents and toolchain', () => {
    write('requirements.txt', 'a\n');
    const m = [path.join(repo, 'requirements.txt')];
    const k1 = depsKey(TOOLCHAINS.python, repo, m);
    expect(depsKey(TOOLCHAINS.python, repo, m)).toBe(k1);
    write('requirements.txt', 'b\n');
    expect(depsKey(TOOLCHAINS.python, repo, m)).not.toBe(k1);
  });
});

describe('prepareToolchain', () => {
  it('prefers an operator-supplied cache over the automatic one', () => {
    process.env.AEGIS_SANDBOX_PYTHON_DEPS = '/srv/py-deps';
    write('requirements.txt', 'six\n');
    expect(prepareToolchain(TOOLCHAINS.python, ctx())).toEqual({ deps: path.resolve('/srv/py-deps') });
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it('with auto-deps off, Python runs without a cache but Java reports what to set', () => {
    process.env.AEGIS_SANDBOX_AUTO_DEPS = 'off';
    expect(prepareToolchain(TOOLCHAINS.python, ctx())).toEqual({ deps: null });
    const java = prepareToolchain(TOOLCHAINS['java-maven'], ctx());
    expect(java.error).toContain('AEGIS_SANDBOX_JAVA_DEPS');
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it('surfaces an install failure as the step error', () => {
    write('pom.xml', '<project/>');
    runInSandbox.mockReturnValue({ success: false, output: 'BUILD FAILURE' });
    expect(prepareToolchain(TOOLCHAINS['java-maven'], ctx()).error).toContain('BUILD FAILURE');
  });
});

describe('noToolchainResult', () => {
  it('fails by default so unverified patches are not committed', () => {
    const r = noToolchainResult('tests');
    expect(r.success).toBe(false);
    expect(r.output).toContain('AEGIS_SANDBOX_ALLOW_UNSUPPORTED');
  });

  it('can be told to skip', () => {
    process.env.AEGIS_SANDBOX_ALLOW_UNSUPPORTED = 'true';
    expect(noToolchainResult('lint').success).toBe(true);
  });
});
