import fs from 'fs';
import path from 'path';
import { runInSandbox } from './sandbox.js';

/**
 * engine/toolchains.js
 *
 * Per-language lint/test profiles for the sandbox. Before this module every
 * lint/test run was hard-wired to ESLint + Vitest from Aegis's own
 * node_modules inside node:22-alpine, so a Python, Go or Java repo could not
 * run through the pipeline at all.
 *
 * A toolchain describes:
 *   • how to detect it from the tenant worktree (marker files at the root)
 *   • which Docker image runs it (overridable per language via env)
 *   • the lint command and the test command
 *   • what the container needs mounted (host node_modules, a dependency cache)
 *
 * Supported: node, python, go, java (Maven or Gradle).
 *
 * The sandbox runs with `--network none`, so nothing can be downloaded at
 * run time. Third-party dependencies therefore have to come from the worktree
 * itself (Go `vendor/`), or from a pre-populated read-only cache mounted at
 * the same path inside the container:
 *
 *   AEGIS_SANDBOX_PYTHON_DEPS   dir made with `pip install --target <dir> ...`
 *   AEGIS_SANDBOX_GO_DEPS       a GOMODCACHE (`go mod download` with GOMODCACHE=<dir>)
 *   AEGIS_SANDBOX_JAVA_DEPS     a Maven local repo, or a Gradle read-only dep
 *                               cache (`modules-2`'s parent). REQUIRED for Java:
 *                               even compiling needs the Maven/Gradle plugins.
 *
 * Image overrides: AEGIS_SANDBOX_IMAGE (node, unchanged), AEGIS_SANDBOX_IMAGE_PYTHON,
 * AEGIS_SANDBOX_IMAGE_GO, AEGIS_SANDBOX_IMAGE_MAVEN, AEGIS_SANDBOX_IMAGE_GRADLE.
 */

// ─── helpers ──────────────────────────────────────────────────────────────────

/** POSIX single-quote a value so paths with spaces/metacharacters stay one argument. */
const q = (s) => `'${String(s).replace(/'/g, '\'\\\'\'')}'`;

/** Worktree-relative, forward-slash path for a file given relative or absolute. */
const rel = (cwd, f) => path.relative(cwd, path.resolve(cwd, f)).split(path.sep).join('/');

const has = (cwd, ...names) => names.some(n => fs.existsSync(path.join(cwd, n)));

function topLevelMatches(cwd, re) {
  try {
    return fs.readdirSync(cwd).some(n => re.test(n));
  } catch {
    return false;
  }
}

function depsDir(envKey) {
  const p = envKey ? process.env[envKey] : undefined;
  return p ? path.resolve(p) : null;
}

const stripExt = (file, re) => path.basename(file).replace(re, '');

// ─── Node ─────────────────────────────────────────────────────────────────────

const NODE = {
  id: 'node',
  label: 'JavaScript/TypeScript (Node)',
  image: () => process.env.AEGIS_SANDBOX_IMAGE ?? 'node:22-alpine',
  // ESLint and Vitest are Aegis's own binaries, run against the tenant's
  // worktree, so the host's node_modules has to be mounted read-only.
  hostNodeModules: true,
  sourceRe: /\.[cm]?[jt]sx?$/,
  testFileRe: /\.(test|spec)\.[cm]?[jt]sx?$/,
  baseName: (file) => stripExt(file, /\.[cm]?[jt]sx?$/).replace(/\.(test|spec)$/, ''),
  detect: (cwd) => has(cwd, 'package.json') || topLevelMatches(cwd, /\.[cm]?js$/),
  env: () => ({}),

  lintCommand({ cwd, files, projectRoot }) {
    const eslint = path.join(projectRoot, 'node_modules', '.bin', 'eslint');
    let targets = ['.'];
    if (files.length > 0) {
      targets = files.filter(f => NODE.sourceRe.test(f)).map(f => path.resolve(cwd, f));
      if (targets.length === 0) return null; // nothing ESLint can check in scope
    }
    return [eslint, '--resolve-plugins-relative-to', projectRoot, ...targets].map(q).join(' ');
  },

  testCommand({ cwd, projectRoot, targets }) {
    const vitest = path.join(projectRoot, 'node_modules', '.bin', 'vitest');
    return [vitest, 'run', '--root', cwd, '--reporter=verbose', ...targets].map(q).join(' ');
  },
};

// ─── Python ───────────────────────────────────────────────────────────────────

// Used when ruff is not in the image: a stdlib-only syntax check. Written to a
// heredoc so no quoting survives into the shell.
const PY_SYNTAX_CHECK = `import ast, os, sys
SKIP = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', '.tox', 'vendor'}
bad = 0
def check(p):
    global bad
    try:
        with open(p, encoding='utf-8') as fh:
            ast.parse(fh.read(), p)
    except SyntaxError as e:
        bad = 1
        print('%s:%s: SyntaxError: %s' % (p, e.lineno, e.msg))
for t in sys.argv[1:]:
    if os.path.isdir(t):
        for root, dirs, names in os.walk(t):
            dirs[:] = [d for d in dirs if d not in SKIP]
            for n in names:
                if n.endswith('.py'):
                    check(os.path.join(root, n))
    else:
        check(t)
sys.exit(bad)`;

const PYTHON = {
  id: 'python',
  label: 'Python',
  // pytest/ruff are used when the image has them (see sandbox/python.Dockerfile);
  // the stock image falls back to unittest + a syntax check.
  image: () => process.env.AEGIS_SANDBOX_IMAGE_PYTHON ?? 'python:3.12-alpine',
  hostNodeModules: false,
  depsEnvKey: 'AEGIS_SANDBOX_PYTHON_DEPS',
  sourceRe: /\.py$/,
  testFileRe: /(?:^|[\\/])(?:test_[^\\/]*|[^\\/]*_test)\.py$/,
  baseName: (file) => stripExt(file, /\.py$/).replace(/^test_/, '').replace(/_test$/, ''),
  detect: (cwd) => has(cwd, 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt',
                       'Pipfile', 'tox.ini', 'pytest.ini'),
  env: ({ cwd, deps }) => ({
    HOME: '/tmp',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: [cwd, path.join(cwd, 'src'), deps].filter(Boolean).join(':'),
  }),

  lintCommand({ cwd, files }) {
    let targets = ['.'];
    if (files.length > 0) {
      targets = files.map(f => rel(cwd, f)).filter(f => PYTHON.sourceRe.test(f));
      if (targets.length === 0) return null;
    }
    const t = targets.map(q).join(' ');
    return [
      `if command -v ruff >/dev/null 2>&1; then ruff check ${t}; else`,
      `python3 - ${t} <<'PY'`,
      PY_SYNTAX_CHECK,
      'PY',
      'fi',
    ].join('\n');
  },

  testCommand({ cwd, targets }) {
    const rels = targets.map(f => rel(cwd, f));
    const pytest = ['python3 -m pytest -q -p no:cacheprovider', ...rels.map(q)].join(' ');
    // `unittest discover` skips directories without __init__.py, so name the
    // modules explicitly (namespace packages import fine).
    const modules = rels.map(f => f.replace(/\.py$/, '').split('/').join('.'));
    const unittest = modules.length > 0
      ? ['python3 -m unittest -v', ...modules.map(q)].join(' ')
      : 'python3 -m unittest discover -v';
    return `if python3 -c 'import pytest' >/dev/null 2>&1; then ${pytest}; else ${unittest}; fi`;
  },
};

// ─── Go ───────────────────────────────────────────────────────────────────────

const GO = {
  id: 'go',
  label: 'Go',
  image: () => process.env.AEGIS_SANDBOX_IMAGE_GO ?? 'golang:1.23-alpine',
  hostNodeModules: false,
  depsEnvKey: 'AEGIS_SANDBOX_GO_DEPS',
  memory: '1g',
  tmpfsBytes: 268435456, // GOCACHE lives in /tmp
  sourceRe: /\.go$/,
  testFileRe: /_test\.go$/,
  baseName: (file) => stripExt(file, /\.go$/).replace(/_test$/, ''),
  detect: (cwd) => has(cwd, 'go.mod'),
  env: ({ deps }) => ({
    HOME: '/tmp',
    GOCACHE: '/tmp/go-build',
    GOPATH: '/tmp/go',
    GOMODCACHE: deps ?? '/tmp/go/pkg/mod',
    GOPROXY: 'off',
    GOTOOLCHAIN: 'local',
    GOFLAGS: '-buildvcs=false', // worktree's .git points outside the mount
    CGO_ENABLED: '0',           // alpine has no C toolchain
  }),

  lintCommand({ cwd, files }) {
    let goFiles = [];
    if (files.length > 0) {
      goFiles = files.map(f => rel(cwd, f)).filter(f => GO.sourceRe.test(f));
      if (goFiles.length === 0) return null;
    }
    const fmt = goFiles.length > 0
      ? `out=$(gofmt -l ${goFiles.map(q).join(' ')})`
      : 'list=$(find . -name \'*.go\' -not -path \'./vendor/*\' -not -path \'./.git/*\'); ' +
        'if [ -n "$list" ]; then out=$(gofmt -l $list); else out=; fi';
    const pkgs = goFiles.length > 0
      ? [...new Set(goFiles.map(f => path.posix.dirname(f)))]
          .map(d => q(d === '.' ? './' : `./${d}`)).join(' ')
      : './...';
    return [
      fmt,
      'if [ -n "$out" ]; then echo "gofmt: these files need formatting:"; echo "$out"; exit 1; fi',
      `go vet ${pkgs}`,
    ].join('\n');
  },

  testCommand({ cwd, targets, scoped }) {
    if (!scoped || targets.length === 0) return 'go test -count=1 ./...';
    const dirs = [...new Set(targets.map(f => path.posix.dirname(rel(cwd, f))))];
    return `go test -count=1 ${dirs.map(d => q(d === '.' ? './' : `./${d}`)).join(' ')}`;
  },
};

// ─── Java ─────────────────────────────────────────────────────────────────────

const JAVA_COMMON = {
  hostNodeModules: false,
  depsEnvKey: 'AEGIS_SANDBOX_JAVA_DEPS',
  requiresDeps: true,
  requiresDepsMessage:
    'Java builds need an offline dependency cache because the sandbox has no network ' +
    '(Maven/Gradle cannot even fetch their own plugins). Set AEGIS_SANDBOX_JAVA_DEPS to a ' +
    'host directory populated ahead of time — a Maven local repository, or for Gradle the ' +
    'directory containing modules-2 — and Aegis mounts it read-only into the container.',
  memory: '1g',
  timeoutMs: 180000,
  tmpfsBytes: 268435456,
  sourceRe: /\.java$/,
  testFileRe: /[\\/]src[\\/]test[\\/](?:.*[\\/])?(?:\w*(?:Test|Tests|IT)|Test\w+)\.java$/,
  baseName: (file) => stripExt(file, /\.java$/).replace(/(Tests?|IT)$/, '').replace(/^Test/, ''),
};

const javaClass = (f) => path.basename(f).replace(/\.java$/, '');

const MAVEN = {
  ...JAVA_COMMON,
  id: 'java-maven',
  label: 'Java (Maven)',
  image: () => process.env.AEGIS_SANDBOX_IMAGE_MAVEN ?? 'maven:3.9-eclipse-temurin-21',
  detect: (cwd) => has(cwd, 'pom.xml'),
  env: () => ({ HOME: '/tmp' }),

  lintCommand({ files, deps }) {
    if (files.length > 0 && !files.some(f => JAVA_COMMON.sourceRe.test(f))) return null;
    // No standard linter ships with Maven; compiling main + test sources is the
    // gate that catches what a patch most often breaks.
    return `mvn -o -B -ntp -q ${mvnRepo(deps)} test-compile`;
  },

  testCommand({ targets, scoped, deps }) {
    const filter = scoped && targets.length > 0
      ? ` -Dtest=${[...new Set(targets.map(javaClass))].join(',')} -Dsurefire.failIfNoSpecifiedTests=false`
      : '';
    return `mvn -o -B -ntp ${mvnRepo(deps)}${filter} test`;
  },
};
const mvnRepo = (deps) => `-Dmaven.repo.local=${q(deps)}`;

const GRADLE = {
  ...JAVA_COMMON,
  id: 'java-gradle',
  label: 'Java (Gradle)',
  image: () => process.env.AEGIS_SANDBOX_IMAGE_GRADLE ?? 'gradle:8-jdk21',
  detect: (cwd) => has(cwd, 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'),
  env: ({ deps }) => ({
    HOME: '/tmp',
    GRADLE_USER_HOME: '/tmp/gradle-home',
    GRADLE_RO_DEP_CACHE: deps,
  }),

  lintCommand({ files }) {
    if (files.length > 0 && !files.some(f => JAVA_COMMON.sourceRe.test(f))) return null;
    return 'gradle --offline --no-daemon -q classes testClasses';
  },

  testCommand({ targets, scoped }) {
    const filter = scoped && targets.length > 0
      ? [...new Set(targets.map(javaClass))].map(c => ` --tests ${q(c)}`).join('')
      : '';
    return `gradle --offline --no-daemon test${filter}`;
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────────

export const TOOLCHAINS = { node: NODE, python: PYTHON, go: GO, 'java-maven': MAVEN, 'java-gradle': GRADLE };

/**
 * detectToolchains(cwd)
 *
 * Every toolchain whose marker files exist at the worktree root, so a repo
 * with both package.json and go.mod runs both. Maven wins over Gradle when
 * both are present. An empty array means no supported language was found.
 *
 * @param {string} cwd
 * @returns {object[]}
 */
export function detectToolchains(cwd) {
  const found = [NODE, PYTHON, GO].filter(tc => tc.detect(cwd));
  if (MAVEN.detect(cwd)) found.push(MAVEN);
  else if (GRADLE.detect(cwd)) found.push(GRADLE);
  return found;
}

/** Output used when a worktree has no supported language at its root. */
export const NO_TOOLCHAIN_NOTICE =
  '[toolchain] No supported language detected at the worktree root ' +
  '(looked for package.json, pyproject.toml/setup.py/requirements.txt, go.mod, pom.xml, ' +
  'build.gradle) — lint/tests skipped.';

/**
 * runToolchainCommand(tc, cmd, ctx)
 *
 * Run one lint/test command for a toolchain through the sandbox with the right
 * image, mounts, env and limits.
 *
 * @param {object} tc
 * @param {string} cmd
 * @param {{ cwd: string, projectRoot: string, tenantId?: string }} ctx
 * @returns {{ success: boolean, output: string }}
 */
export function runToolchainCommand(tc, cmd, { cwd, projectRoot, tenantId }) {
  const deps = depsDir(tc.depsEnvKey);
  if (tc.requiresDeps && !deps) {
    return { success: false, output: `[toolchain:${tc.id}] ${tc.requiresDepsMessage}` };
  }
  return runInSandbox(cmd, cwd, projectRoot, tenantId, {
    toolchain: tc.id,
    image: tc.image(),
    hostNodeModules: Boolean(tc.hostNodeModules),
    deps,
    env: tc.env({ cwd, deps }),
    memory: tc.memory,
    timeoutMs: tc.timeoutMs,
    tmpfsBytes: tc.tmpfsBytes,
  });
}

/**
 * Context handed to lintCommand/testCommand: the deps dir is needed by the Maven
 * command line, so resolve it in one place.
 */
export function commandContext(tc, base) {
  return { ...base, deps: depsDir(tc.depsEnvKey) };
}
