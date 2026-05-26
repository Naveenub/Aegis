import fs from 'fs';
import path from 'path';

const BLOCKED = ['.env', 'secrets'];

export function parsePatch(patch) {
  return JSON.parse(patch);
}

export function applyPatch(file, content) {
  try {
    const root = process.cwd();
    const resolved = path.resolve(file);

    if (!resolved.startsWith(root + path.sep)) {
      console.log('Blocked path traversal:', file);
      return;
    }

    if (BLOCKED.some(b => file.includes(b))) {
      console.log('Blocked file:', file);
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