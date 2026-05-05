import fs from 'fs';

const BLOCKED = ['.env', 'secrets'];

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

    fs.writeFileSync(file, content);
    console.log('Updated:', file);

  } catch (e) {
    console.log('Patch error', e);
  }
}
