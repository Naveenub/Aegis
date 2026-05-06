import fs from 'fs';

const LOCK_DIR = '.aegis-locks';

if (!fs.existsSync(LOCK_DIR)) {
  fs.mkdirSync(LOCK_DIR);
}

function getLockPath(file) {
  return `${LOCK_DIR}/${file.replace(/\//g, '_')}.lock`;
}

export function acquireLock(file, timeout = 10000) {
  const lockPath = getLockPath(file);
  const start = Date.now();

  while (true) {
    try {
      fs.writeFileSync(lockPath, process.pid.toString(), { flag: 'wx' });
      return lockPath;
    } catch {
      if (Date.now() - start > timeout) {
        throw new Error(`Timeout acquiring lock for ${file}`);
      }
    }
  }
}

export function releaseLock(lockPath) {
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
  }
}
