import fs from 'fs';

const BLOCKED = ['.env', 'secrets'];

export function parsePatch(patch) {
  return JSON.parse(patch);
}

export function applyPatch(file, content) {
  try {
    if (BLOCKED.some(b => file.includes(b))) {
      console.log('Blocked file:', file);
      return;
    }

    if (content.length > 50000) {
      throw new Error('Patch too large');
    }

    if (fs.existsSync(file)) {
      fs.copyFileSync(file, file + '.bak');
    }

    fs.writeFileSync(file, content);
    console.log('Updated:', file);

  } catch (e) {
    console.log('Patch error', e);
  }
}
