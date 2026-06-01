/**
 * tests/repo-scanner.test.js
 *
 * Unit tests for engine/repo-scanner.js
 *
 * Covers:
 *   scanRepo()     — async walk: files collected, PRUNE_DIRS skipped,
 *                    unreadable directories skipped, symlinks skipped,
 *                    nested structure traversed, defaults to process.cwd()
 *   scanRepoSync() — sync walk: same behavioural contract, separate export
 *
 * fs and fs/promises are mocked so no real filesystem I/O occurs.
 * The mock models a small in-memory tree:
 *
 *   /repo
 *   ├── engine/
 *   │   ├── agent-runner.js
 *   │   └── repo-scanner.js
 *   ├── tests/
 *   │   └── repo-scanner.test.js
 *   ├── node_modules/          ← pruned
 *   │   └── lodash/index.js
 *   ├── .git/                  ← pruned
 *   │   └── config
 *   └── package.json
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── In-memory filesystem tree ────────────────────────────────────────────────

/**
 * Dirent-like object that satisfies the withFileTypes API.
 * Both the async (fs/promises) and sync (fs) readdirSync mocks return these.
 */
function makeDirent(name, type = 'file') {
  return {
    name,
    isDirectory: () => type === 'dir',
    isFile:      () => type === 'file',
    isSymbolicLink: () => type === 'symlink',
  };
}

/**
 * Tree descriptor.  Each key is an absolute directory path; its value is
 * an array of { name, type } entries present in that directory.
 * 'error' type causes readdir to throw (simulates a vanished directory).
 */
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
  // These entries exist in the tree but must never be visited (pruned)
  '/repo/node_modules': [
    { name: 'lodash', type: 'dir' },
  ],
  '/repo/node_modules/lodash': [
    { name: 'index.js', type: 'file' },
  ],
  '/repo/.git': [
    { name: 'config', type: 'file' },
  ],
};

function readDirEntries(dirPath) {
  const entries = TREE[dirPath];
  if (!entries) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return entries.map(e => makeDirent(e.name, e.type));
}

// ─── Mock fs/promises ─────────────────────────────────────────────────────────

vi.mock('fs/promises', () => ({
  default: {
    readdir: vi.fn(async (dirPath) => readDirEntries(dirPath)),
  },
}));

// ─── Mock fs ──────────────────────────────────────────────────────────────────

vi.mock('fs', () => ({
  default: {
    readdirSync: vi.fn((dirPath) => readDirEntries(dirPath)),
  },
}));

// ─── Module under test ────────────────────────────────────────────────────────

import { scanRepo, scanRepoSync } from '../engine/repo-scanner.js';
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
      // None of the returned paths should be a directory name without extension
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
    // package.json + engine/agent-runner.js + engine/repo-scanner.js + tests/repo-scanner.test.js
    expect(files).toHaveLength(4);
  });

  it('skips a directory that disappears mid-walk without throwing', async () => {
    fsPromises.readdir.mockImplementationOnce(async (p) => {
      if (p === '/repo') return readDirEntries('/repo');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // Should resolve, not reject
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
    // The mock will throw for process.cwd() since it is not in TREE,
    // so we just verify readdir is called with process.cwd().
    const cwd = process.cwd();
    fsPromises.readdir.mockRejectedValueOnce(new Error('ENOENT'));
    await scanRepo();
    expect(fsPromises.readdir).toHaveBeenCalledWith(cwd, { withFileTypes: true });
  });

  it('traverses arbitrarily nested directories', async () => {
    // Extend the tree with a deeper path for this test only
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
    const files = scanRepoSync('/repo');
    expect(files.every(f => !f.includes('node_modules'))).toBe(true);
  });

  it('prunes .git entirely', () => {
    const files = scanRepoSync('/repo');
    expect(files.every(f => !f.includes('.git'))).toBe(true);
  });

  it('skips symlinks without error', () => {
    const files = scanRepoSync('/repo');
    expect(files).not.toContain('/repo/dangling.lnk');
  });

  it('returns exactly the expected file count', () => {
    const files = scanRepoSync('/repo');
    expect(files).toHaveLength(4);
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
    // Restore the default implementations that vi.clearAllMocks() wipes.
    // clearAllMocks() resets call history AND the mock implementation set
    // inside the vi.mock() factory, so without this both fns return undefined
    // and scanRepo collects an empty array instead of the expected 4 files.
    fsPromises.readdir.mockImplementation(async (dirPath) => readDirEntries(dirPath));
    fs.readdirSync.mockImplementation((dirPath) => readDirEntries(dirPath));
  });

  it('both return the same file set for the same root', async () => {
    const asyncFiles = await scanRepo('/repo');
    const syncFiles  = scanRepoSync('/repo');

    // Sort both before comparing — walk order is not guaranteed to match
    expect(asyncFiles.slice().sort()).toEqual(syncFiles.slice().sort());
  });
});
