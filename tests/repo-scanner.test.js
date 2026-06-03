/**
 * tests/repo-scanner.test.js
 *
 * Unit tests for engine/repo-scanner.js
 *
 * Covers:
 *   scanRepo()           — async walk (unchanged contract)
 *   scanRepoSync()       — sync walk  (unchanged contract)
 *   analyzeRepo()        — semantic analysis: symbol table, import graph,
 *                          call graph, dependency map
 *   formatRepoContext()  — structured prompt-string output
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── In-memory filesystem tree ────────────────────────────────────────────────

function makeDirent(name, type = 'file') {
  return {
    name,
    isDirectory:    () => type === 'dir',
    isFile:         () => type === 'file',
    isSymbolicLink: () => type === 'symlink',
  };
}

const TREE = {
  '/repo': [
    { name: 'engine',       type: 'dir'  },
    { name: 'tests',        type: 'dir'  },
    { name: 'node_modules', type: 'dir'  },
    { name: '.git',         type: 'dir'  },
    { name: 'package.json', type: 'file' },
    { name: 'dangling.lnk', type: 'symlink' },
  ],
  '/repo/engine': [
    { name: 'agent-runner.js',   type: 'file' },
    { name: 'repo-scanner.js',   type: 'file' },
  ],
  '/repo/tests': [
    { name: 'repo-scanner.test.js', type: 'file' },
  ],
  '/repo/node_modules': [{ name: 'lodash', type: 'dir' }],
  '/repo/node_modules/lodash': [{ name: 'index.js', type: 'file' }],
  '/repo/.git': [{ name: 'config', type: 'file' }],
};

function readDirEntries(dirPath) {
  const entries = TREE[dirPath];
  if (!entries) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return entries.map(e => makeDirent(e.name, e.type));
}

// ─── Mock fs/promises and fs ──────────────────────────────────────────────────

vi.mock('fs/promises', () => ({
  default: {
    readdir: vi.fn(async (dirPath) => readDirEntries(dirPath)),
  },
}));

vi.mock('fs', () => ({
  default: {
    readdirSync:  vi.fn((dirPath) => readDirEntries(dirPath)),
    readFileSync: vi.fn(() => ''),
    statSync:     vi.fn(() => ({ size: 0 })),
    accessSync:   vi.fn(() => { throw new Error('ENOENT'); }),
    constants:    { F_OK: 0 },
  },
}));

import { scanRepo, scanRepoSync, analyzeRepo, formatRepoContext } from '../engine/repo-scanner.js';
import fsPromises from 'fs/promises';
import fs         from 'fs';

// ─── scanRepo (async) ─────────────────────────────────────────────────────────

describe('scanRepo (async)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns all regular files under root', async () => {
    const files = await scanRepo('/repo');
    expect(files).toEqual(expect.arrayContaining([
      '/repo/package.json',
      '/repo/engine/agent-runner.js',
      '/repo/engine/repo-scanner.js',
      '/repo/tests/repo-scanner.test.js',
    ]));
  });

  it('does not return directory paths, only files', async () => {
    const files = await scanRepo('/repo');
    for (const f of files) {
      expect(TREE[f]).toBeUndefined();
    }
  });

  it('prunes node_modules entirely', async () => {
    const files = await scanRepo('/repo');
    expect(files.every(f => !f.includes('node_modules'))).toBe(true);
  });

  it('prunes .git entirely', async () => {
    const files = await scanRepo('/repo');
    expect(files.every(f => !f.includes('.git'))).toBe(true);
  });

  it('skips symlinks without error', async () => {
    const files = await scanRepo('/repo');
    expect(files).not.toContain('/repo/dangling.lnk');
  });

  it('returns exactly the expected file count', async () => {
    const files = await scanRepo('/repo');
    expect(files).toHaveLength(4);
  });

  it('skips a directory that disappears mid-walk without throwing', async () => {
    fsPromises.readdir.mockImplementationOnce(async (p) => {
      if (p === '/repo') return readDirEntries('/repo');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    await expect(scanRepo('/repo')).resolves.toBeDefined();
  });

  it('resolves to an empty array when root itself is unreadable', async () => {
    fsPromises.readdir.mockRejectedValueOnce(
      Object.assign(new Error('EPERM'), { code: 'EPERM' })
    );
    const files = await scanRepo('/nonexistent');
    expect(files).toEqual([]);
  });

  it('defaults root to process.cwd() when called with no arguments', async () => {
    const cwd = process.cwd();
    fsPromises.readdir.mockRejectedValueOnce(new Error('ENOENT'));
    await scanRepo();
    expect(fsPromises.readdir).toHaveBeenCalledWith(cwd, { withFileTypes: true });
  });

  it('traverses arbitrarily nested directories', async () => {
    const deepTree = {
      '/deep': [{ name: 'a', type: 'dir' }],
      '/deep/a': [{ name: 'b', type: 'dir' }],
      '/deep/a/b': [{ name: 'file.js', type: 'file' }],
    };
    fsPromises.readdir.mockImplementation(async (p) => {
      const entries = deepTree[p];
      if (!entries) throw new Error('ENOENT');
      return entries.map(e => makeDirent(e.name, e.type));
    });
    const files = await scanRepo('/deep');
    expect(files).toEqual(['/deep/a/b/file.js']);
  });

  it('uses fs.promises.readdir (not readdirSync)', async () => {
    await scanRepo('/repo');
    expect(fsPromises.readdir).toHaveBeenCalled();
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it('passes withFileTypes: true to readdir', async () => {
    await scanRepo('/repo');
    for (const call of fsPromises.readdir.mock.calls) {
      expect(call[1]).toEqual({ withFileTypes: true });
    }
  });
});

// ─── scanRepoSync ─────────────────────────────────────────────────────────────

describe('scanRepoSync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns all regular files under root', () => {
    const files = scanRepoSync('/repo');
    expect(files).toEqual(expect.arrayContaining([
      '/repo/package.json',
      '/repo/engine/agent-runner.js',
      '/repo/engine/repo-scanner.js',
      '/repo/tests/repo-scanner.test.js',
    ]));
  });

  it('prunes node_modules entirely', () => {
    expect(scanRepoSync('/repo').every(f => !f.includes('node_modules'))).toBe(true);
  });

  it('prunes .git entirely', () => {
    expect(scanRepoSync('/repo').every(f => !f.includes('.git'))).toBe(true);
  });

  it('skips symlinks without error', () => {
    expect(scanRepoSync('/repo')).not.toContain('/repo/dangling.lnk');
  });

  it('returns exactly the expected file count', () => {
    expect(scanRepoSync('/repo')).toHaveLength(4);
  });

  it('skips an unreadable directory without throwing', () => {
    fs.readdirSync.mockImplementationOnce((p) => {
      if (p === '/repo') return readDirEntries('/repo');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(() => scanRepoSync('/repo')).not.toThrow();
  });

  it('returns empty array when root itself is unreadable', () => {
    fs.readdirSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    expect(scanRepoSync('/nonexistent')).toEqual([]);
  });

  it('uses readdirSync (not fs.promises.readdir)', () => {
    scanRepoSync('/repo');
    expect(fs.readdirSync).toHaveBeenCalled();
    expect(fsPromises.readdir).not.toHaveBeenCalled();
  });

  it('passes withFileTypes: true to readdirSync', () => {
    scanRepoSync('/repo');
    for (const call of fs.readdirSync.mock.calls) {
      expect(call[1]).toEqual({ withFileTypes: true });
    }
  });

  it('defaults root to process.cwd() when called with no arguments', () => {
    const cwd = process.cwd();
    fs.readdirSync.mockImplementationOnce(() => { throw new Error('ENOENT'); });
    scanRepoSync();
    expect(fs.readdirSync).toHaveBeenCalledWith(cwd, { withFileTypes: true });
  });
});

// ─── Contract parity between async and sync ───────────────────────────────────

describe('scanRepo vs scanRepoSync — output parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsPromises.readdir.mockImplementation(async (dirPath) => readDirEntries(dirPath));
    fs.readdirSync.mockImplementation((dirPath) => readDirEntries(dirPath));
  });

  it('both return the same file set for the same root', async () => {
    const asyncFiles = await scanRepo('/repo');
    const syncFiles  = scanRepoSync('/repo');
    expect(asyncFiles.slice().sort()).toEqual(syncFiles.slice().sort());
  });
});

// ─── analyzeRepo — semantic analysis ─────────────────────────────────────────

describe('analyzeRepo — semantic analysis', () => {
  const exportedFunctionSource = `
    import { helper } from './helper.js';
    export function doWork(x) {
      return helper(x);
    }
    export class Worker {
      run() { doWork(1); }
    }
    export const VERSION = '1.0';
  `;

  const helperSource = `
    export function helper(x) { return x * 2; }
  `;

  beforeEach(() => {
    vi.clearAllMocks();
    // Provide a simple two-file virtual repo
    fsPromises.readdir.mockImplementation(async (dirPath) => {
      if (dirPath === '/proj') {
        return [
          makeDirent('main.js', 'file'),
          makeDirent('helper.js', 'file'),
        ];
      }
      throw new Error('ENOENT');
    });

    fs.statSync.mockReturnValue({ size: 500 });
    fs.readFileSync.mockImplementation((p) => {
      if (p === '/proj/main.js')   return exportedFunctionSource;
      if (p === '/proj/helper.js') return helperSource;
      return '';
    });
    // accessSync succeeds for helper.js (resolveSpecifier uses it)
    fs.accessSync.mockImplementation((p) => {
      if (p === '/proj/helper.js') return;
      throw new Error('ENOENT');
    });
  });

  it('returns a RepoAnalysis with all required keys', async () => {
    const analysis = await analyzeRepo('/proj');
    expect(analysis).toHaveProperty('files');
    expect(analysis).toHaveProperty('fileMap');
    expect(analysis).toHaveProperty('importGraph');
    expect(analysis).toHaveProperty('dependencyMap');
    expect(analysis).toHaveProperty('symbolTable');
  });

  it('files array contains all walked files', async () => {
    const analysis = await analyzeRepo('/proj');
    expect(analysis.files).toEqual(
      expect.arrayContaining(['/proj/main.js', '/proj/helper.js'])
    );
  });

  it('symbolTable lists exported symbols from main.js', async () => {
    const analysis = await analyzeRepo('/proj');
    const syms = analysis.symbolTable.get('/proj/main.js') ?? [];
    const names = syms.map(s => s.name);
    expect(names).toContain('doWork');
    expect(names).toContain('Worker');
    expect(names).toContain('VERSION');
  });

  it('exported symbol kinds are correct', async () => {
    const analysis = await analyzeRepo('/proj');
    const syms = analysis.symbolTable.get('/proj/main.js') ?? [];
    const byName = Object.fromEntries(syms.map(s => [s.name, s]));
    expect(byName.doWork?.kind).toBe('function');
    expect(byName.Worker?.kind).toBe('class');
  });

  it('all symbolTable entries are marked exported:true', async () => {
    const analysis = await analyzeRepo('/proj');
    for (const [, syms] of analysis.symbolTable) {
      for (const s of syms) {
        expect(s.exported).toBe(true);
      }
    }
  });

  it('importGraph maps main.js → helper.js', async () => {
    const analysis = await analyzeRepo('/proj');
    const imports = analysis.importGraph.get('/proj/main.js') ?? [];
    expect(imports).toContain('/proj/helper.js');
  });

  it('dependencyMap maps helper.js ← main.js', async () => {
    const analysis = await analyzeRepo('/proj');
    const deps = analysis.dependencyMap.get('/proj/helper.js') ?? [];
    expect(deps).toContain('/proj/main.js');
  });

  it('fileMap contains a FileAnalysis for each JS file', async () => {
    const analysis = await analyzeRepo('/proj');
    expect(analysis.fileMap.has('/proj/main.js')).toBe(true);
    expect(analysis.fileMap.has('/proj/helper.js')).toBe(true);
  });

  it('call graph captures helper() invocation inside doWork', async () => {
    const analysis = await analyzeRepo('/proj');
    const fa    = analysis.fileMap.get('/proj/main.js');
    const calls = fa?.calls ?? [];
    const found = calls.find(c => c.callee === 'helper' && c.caller === 'doWork');
    expect(found).toBeDefined();
  });

  it('does not throw on files larger than the parse size limit', async () => {
    fs.statSync.mockReturnValue({ size: 999_999_999 });
    await expect(analyzeRepo('/proj')).resolves.toBeDefined();
  });

  it('records parseError for unreadable files', async () => {
    fs.readFileSync.mockImplementation(() => { throw new Error('EPERM'); });
    const analysis = await analyzeRepo('/proj');
    for (const [, fa] of analysis.fileMap) {
      expect(fa.parseError).not.toBeNull();
    }
  });

  it('records parseError for files with syntax errors', async () => {
    fs.statSync.mockReturnValue({ size: 10 });
    fs.readFileSync.mockReturnValue('this is }{{{ not valid js !!!');
    const analysis = await analyzeRepo('/proj');
    for (const [, fa] of analysis.fileMap) {
      expect(fa.parseError).not.toBeNull();
    }
  });
});

// ─── formatRepoContext ────────────────────────────────────────────────────────

describe('formatRepoContext', () => {
  it('returns a non-empty string', () => {
    const analysis = {
      files: ['/root/a.js', '/root/b.js'],
      fileMap: new Map([
        ['/root/a.js', { filePath: '/root/a.js', calls: [{ caller: 'main', callee: 'doWork', line: 5 }], parseError: null }],
        ['/root/b.js', { filePath: '/root/b.js', calls: [], parseError: null }],
      ]),
      importGraph:   new Map([['/root/a.js', ['/root/b.js']], ['/root/b.js', []]]),
      dependencyMap: new Map([['/root/a.js', []], ['/root/b.js', ['/root/a.js']]]),
      symbolTable:   new Map([['/root/b.js', [{ kind: 'function', name: 'doWork', exported: true, line: 1 }]]]),
    };

    const ctx = formatRepoContext(analysis, { root: '/root' });
    expect(typeof ctx).toBe('string');
    expect(ctx.length).toBeGreaterThan(0);
  });

  it('contains REPO FILE TREE section', () => {
    const analysis = {
      files: ['/r/a.js'],
      fileMap: new Map(),
      importGraph: new Map(),
      dependencyMap: new Map(),
      symbolTable: new Map(),
    };
    expect(formatRepoContext(analysis, { root: '/r' })).toContain('REPO FILE TREE');
  });

  it('contains EXPORTED SYMBOLS section', () => {
    const analysis = {
      files: ['/r/a.js'],
      fileMap: new Map(),
      importGraph: new Map(),
      dependencyMap: new Map(),
      symbolTable: new Map([['/r/a.js', [{ kind: 'function', name: 'foo', exported: true, line: 1 }]]]),
    };
    expect(formatRepoContext(analysis, { root: '/r' })).toContain('EXPORTED SYMBOLS');
  });

  it('contains IMPORT GRAPH section', () => {
    const analysis = {
      files: [],
      fileMap: new Map(),
      importGraph: new Map([['/r/a.js', ['/r/b.js']]]),
      dependencyMap: new Map(),
      symbolTable: new Map(),
    };
    expect(formatRepoContext(analysis, { root: '/r' })).toContain('IMPORT GRAPH');
  });

  it('contains DEPENDENCY MAP section', () => {
    const analysis = {
      files: [],
      fileMap: new Map(),
      importGraph: new Map(),
      dependencyMap: new Map([['/r/b.js', ['/r/a.js']]]),
      symbolTable: new Map(),
    };
    expect(formatRepoContext(analysis, { root: '/r' })).toContain('DEPENDENCY MAP');
  });

  it('contains CALL GRAPH section when calls exist', () => {
    const analysis = {
      files: [],
      fileMap: new Map([['/r/a.js', { filePath: '/r/a.js', calls: [{ caller: 'f', callee: 'g', line: 3 }], parseError: null }]]),
      importGraph: new Map(),
      dependencyMap: new Map(),
      symbolTable: new Map(),
    };
    expect(formatRepoContext(analysis, { root: '/r' })).toContain('CALL GRAPH');
  });

  it('includes PARSE ERRORS section when files failed to parse', () => {
    const analysis = {
      files: ['/r/broken.js'],
      fileMap: new Map([['/r/broken.js', { filePath: '/r/broken.js', calls: [], parseError: 'Unexpected token' }]]),
      importGraph: new Map(),
      dependencyMap: new Map(),
      symbolTable: new Map(),
    };
    expect(formatRepoContext(analysis, { root: '/r' })).toContain('PARSE ERRORS');
  });

  it('uses relative paths (not absolute) in output', () => {
    const analysis = {
      files: ['/root/src/util.js'],
      fileMap: new Map(),
      importGraph: new Map(),
      dependencyMap: new Map(),
      symbolTable: new Map([['/root/src/util.js', [{ kind: 'function', name: 'util', exported: true, line: 1 }]]]),
    };
    const ctx = formatRepoContext(analysis, { root: '/root' });
    expect(ctx).toContain('src/util.js');
    expect(ctx).not.toContain('/root/src/util.js');
  });
});
