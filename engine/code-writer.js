import fs from 'fs';
import path from 'path';

// PROJECT_ROOT is the fallback root used when no explicit cwd is supplied
// (e.g. from tests or direct CLI calls).  Worker code should always pass the
// tenant worktree path so writes land in the correct isolated directory.
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

// Blocked basenames — checked against the *resolved* filename, not raw input.
// Substring matching on raw input can be bypassed (e.g. "myenv" passes ".env"
// check but "env" alone would not; symlinks could also redirect past a raw check).
const BLOCKED_NAMES = ['.env', 'secrets'];

/**
 * Validate that a resolved absolute path is safe to write.
 * @param {string} resolved  - Absolute path that will be written.
 * @param {string} [root]    - Allowed root directory.  Defaults to PROJECT_ROOT.
 * Returns null on success, or an error string on failure.
 */
export function validateTargetPath(resolved, root = PROJECT_ROOT) {
  // 1. Must stay inside the allowed root (path traversal guard).
  if (!resolved.startsWith(root + path.sep)) {
    return `Path traversal blocked: ${resolved}`;
  }

  // 2. Basename must not match any blocked name (exact or containing).
  const base = path.basename(resolved);
  const blocked = BLOCKED_NAMES.find(b => base === b || base.includes(b));
  if (blocked) {
    return `Blocked filename pattern "${blocked}" in: ${base}`;
  }

  return null; // safe
}

export function parsePatch(patch) {
  return JSON.parse(patch);
}

/**
 * Write `content` to `file` inside the given worktree root.
 * @param {string} file     - Relative path supplied by the patch (e.g. "src/foo.js").
 * @param {string} content  - File content to write.
 * @param {string} [cwd]    - Absolute path to the tenant worktree.  Defaults to
 *                            PROJECT_ROOT so direct / test callers keep working,
 *                            but every worker call MUST pass the worktree path
 *                            returned by ensureWorkflowBranch() to stay isolated.
 */
export function applyPatch(file, content, cwd = PROJECT_ROOT) {
  try {
    const root     = path.resolve(cwd);           // normalise (removes trailing sep, etc.)
    const resolved = path.resolve(root, file);

    const pathError = validateTargetPath(resolved, root);
    if (pathError) {
      console.log('Security block —', pathError);
      return;
    }

    if (content.length > 50000) {
      throw new Error('Patch too large');
    }

    fs.writeFileSync(resolved, content);
    console.log('Updated:', resolved);

  } catch (e) {
    console.log('Patch error', e);
  }
}
