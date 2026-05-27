import fs from 'fs';
import path from 'path';

// Lock the allowed root to the project directory at module load time.
// Using process.cwd() at call-time is unsafe — worker processes may have
// a different cwd than the project root.
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

// Blocked basenames — checked against the *resolved* filename, not raw input.
// Substring matching on raw input can be bypassed (e.g. "myenv" passes ".env"
// check but "env" alone would not; symlinks could also redirect past a raw check).
const BLOCKED_NAMES = ['.env', 'secrets'];

/**
 * Validate that a resolved absolute path is safe to write.
 * Returns null on success, or an error string on failure.
 */
export function validateTargetPath(resolved) {
  // 1. Must stay inside the project root (path traversal guard).
  if (!resolved.startsWith(PROJECT_ROOT + path.sep)) {
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

export function applyPatch(file, content) {
  try {
    const resolved = path.resolve(PROJECT_ROOT, file);

    const pathError = validateTargetPath(resolved);
    if (pathError) {
      console.log('Security block —', pathError);
      return;
    }

    if (content.length > 50000) {
      throw new Error('Patch too large');
    }

    if (fs.existsSync(resolved)) {
      fs.copyFileSync(resolved, resolved + '.bak');
    }

    fs.writeFileSync(resolved, content);
    console.log('Updated:', resolved);

  } catch (e) {
    console.log('Patch error', e);
  }
}