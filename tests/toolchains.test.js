import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectToolchains, TOOLCHAINS } from '../engine/toolchains.js';

vi.mock('../engine/sandbox.js', () => ({ runInSandbox: vi.fn() }));

let dir;
const touch = (...names) => names.forEach(n => {
  fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true });
  fs.writeFileSync(path.join(dir, n), '');
});
const ids = () => detectToolchains(dir).map(t => t.id);

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-tc-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.AEGIS_SANDBOX_IMAGE_GO; });

describe('detectToolchains', () => {
  it('detects each language from its marker files', () => {
    touch('package.json');                 expect(ids()).toEqual(['node']);
    fs.rmSync(path.join(dir, 'package.json'));
    touch('requirements.txt');             expect(ids()).toEqual(['python']);
    fs.rmSync(path.join(dir, 'requirements.txt'));
    touch('go.mod');                       expect(ids()).toEqual(['go']);
    fs.rmSync(path.join(dir, 'go.mod'));
    touch('pom.xml');                      expect(ids()).toEqual(['java-maven']);
  });

  it('returns every language of a polyglot repo, Maven winning over Gradle', () => {
    touch('package.json', 'go.mod', 'pom.xml', 'build.gradle');
    expect(ids()).toEqual(['node', 'go', 'java-maven']);
  });

  it('detects Gradle when there is no pom', () => {
    touch('build.gradle.kts');
    expect(ids()).toEqual(['java-gradle']);
  });

  it('returns nothing for an unsupported repo', () => {
    touch('Cargo.toml', 'src/main.rs');
    expect(ids()).toEqual([]);
  });
});

describe('node toolchain', () => {
  const ctx = { cwd: '/w', projectRoot: '/p', files: [] };

  it('needs the host node_modules; the others do not', () => {
    expect(TOOLCHAINS.node.hostNodeModules).toBe(true);
    for (const id of ['python', 'go', 'java-maven', 'java-gradle']) {
      expect(TOOLCHAINS[id].hostNodeModules).toBe(false);
    }
  });

  it('quotes paths and skips lint when no file is lintable', () => {
    expect(TOOLCHAINS.node.lintCommand({ ...ctx, files: ['a b.js'] })).toContain("'/w/a b.js'");
    expect(TOOLCHAINS.node.lintCommand({ ...ctx, files: ['x; rm -rf /.js'] })).toContain("'/w/x; rm -rf /.js'");
    expect(TOOLCHAINS.node.lintCommand({ ...ctx, files: ['notes.md'] })).toBeNull();
  });
});

describe('python toolchain', () => {
  const py = TOOLCHAINS.python;

  it('lints only python files and skips when there are none', () => {
    expect(py.lintCommand({ cwd: '/w', files: ['pkg/a.py', 'README.md'] })).toContain("'pkg/a.py'");
    expect(py.lintCommand({ cwd: '/w', files: ['README.md'] })).toBeNull();
  });

  it('names test modules explicitly for the unittest fallback', () => {
    const cmd = py.testCommand({ cwd: '/w', targets: ['/w/tests/test_a.py'], scoped: true });
    expect(cmd).toContain("python3 -m unittest -v 'tests.test_a'");
    expect(cmd).toContain("python3 -m pytest -q -p no:cacheprovider 'tests/test_a.py'");
  });

  it('matches tests to sources by base name', () => {
    expect(py.baseName('pkg/util.py')).toBe(py.baseName('tests/test_util.py'));
    expect(py.baseName('pkg/util.py')).toBe(py.baseName('pkg/util_test.py'));
    expect(py.testFileRe.test('tests/test_util.py')).toBe(true);
    expect(py.testFileRe.test('pkg/util.py')).toBe(false);
  });
});

describe('go toolchain', () => {
  const go = TOOLCHAINS.go;

  it('scopes vet and test to the patched packages', () => {
    const lint = go.lintCommand({ cwd: '/w', files: ['internal/calc/calc.go'] });
    expect(lint).toContain("gofmt -l 'internal/calc/calc.go'");
    expect(lint).toContain("go vet './internal/calc'");
    const test = go.testCommand({ cwd: '/w', targets: ['/w/internal/calc/calc_test.go'], scoped: true });
    expect(test).toBe("go test -count=1 './internal/calc'");
    expect(go.testCommand({ cwd: '/w', targets: ['/w/a_test.go'], scoped: false })).toBe('go test -count=1 ./...');
  });

  it('has an offline, vcs-free environment and honours the image override', () => {
    expect(go.env({ deps: '/deps' })).toMatchObject({ GOPROXY: 'off', GOMODCACHE: '/deps', GOFLAGS: '-buildvcs=false' });
    process.env.AEGIS_SANDBOX_IMAGE_GO = 'golang:1.24-alpine';
    expect(go.image()).toBe('golang:1.24-alpine');
  });
});

describe('java toolchains', () => {
  it('require an offline dependency cache', () => {
    expect(TOOLCHAINS['java-maven'].requiresDeps).toBe(true);
    expect(TOOLCHAINS['java-gradle'].requiresDeps).toBe(true);
  });

  it('builds offline Maven commands scoped by test class', () => {
    const mvn = TOOLCHAINS['java-maven'];
    expect(mvn.lintCommand({ files: ['src/main/java/A.java'], deps: '/m2' })).toContain("-Dmaven.repo.local='/m2' test-compile");
    expect(mvn.lintCommand({ files: ['README.md'], deps: '/m2' })).toBeNull();
    const cmd = mvn.testCommand({ targets: ['/w/src/test/java/com/x/FooTest.java'], scoped: true, deps: '/m2' });
    expect(cmd).toContain('-o -B');
    expect(cmd).toContain('-Dtest=FooTest');
  });

  it('builds offline Gradle commands scoped by test class', () => {
    const gr = TOOLCHAINS['java-gradle'];
    expect(gr.testCommand({ targets: ['/w/src/test/java/FooTest.java'], scoped: true }))
      .toBe("gradle --offline --no-daemon test --tests 'FooTest'");
    expect(gr.env({ deps: '/ro' })).toMatchObject({ GRADLE_RO_DEP_CACHE: '/ro' });
  });

  it('pairs FooTest.java with Foo.java and recognises test files', () => {
    const j = TOOLCHAINS['java-maven'];
    expect(j.baseName('src/main/java/Foo.java')).toBe(j.baseName('src/test/java/FooTest.java'));
    expect(j.testFileRe.test('/w/src/test/java/com/x/FooTest.java')).toBe(true);
    expect(j.testFileRe.test('/w/src/main/java/com/x/Foo.java')).toBe(false);
  });
});
