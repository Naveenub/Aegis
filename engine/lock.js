import IORedis from 'ioredis';
import Redlock from 'redlock';

const redis = new IORedis();

// Redlock setup
const redlock = new Redlock(
  [redis],
  {
    retryCount: 5,
    retryDelay: 200, // ms
    retryJitter: 100
  }
);

// 🔒 acquire distributed lock
export async function acquireLock(file) {
  const resource = `locks:${file}`;

  const lock = await redlock.acquire([resource], 10000); // 10s TTL

  return lock;
}

// 🔓 release lock
export async function releaseLock(lock) {
  try {
    await lock.release();
  } catch (err) {
    // lock might already be released/expired
  }
}
