import fs from 'fs';

const BLOCKED = ['.env', 'secrets'];

export function parsePatch(patch) {
  return JSON.parse(patch);
}

export function applyPatch(patch) {
  try {
    const { file, content } = JSON.parse(patch);

    if (BLOCKED.some(b => file.includes(b))) {
      console.log('Blocked file:', file);
      return;
    }

    if (fs.existsSync(file)) {
      fs.copyFileSync(file, file + '.bak');
    }

    if (content.length > 50000) {
      throw new Error('Patch too large');
    }
    
    fs.writeFileSync(file, content);
    console.log('Updated:', file);

  } catch (e) {
    console.log('Patch error', e);
  }
}
