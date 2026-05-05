import fs from 'fs';
import path from 'path';

export function scanRepo() {
  const files = [];

  function walk(dir) {
    for (const file of fs.readdirSync(dir)) {
      const full = path.join(dir, file);

      if (file === 'node_modules' || file.startsWith('.git')) continue;

      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push(full);
      }
    }
  }

  walk(process.cwd());
  return files;
}
