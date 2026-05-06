const locks = new Set();

export async function acquireLock(file) {
  while (locks.has(file)) {
    await new Promise(r => setTimeout(r, 50));
  }
  locks.add(file);
}

export function releaseLock(file) {
  locks.delete(file);
}
