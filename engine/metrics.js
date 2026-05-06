import fs from 'fs';

const PATH = '.claude/context/metrics.json';

function load() {
  if (!fs.existsSync(PATH)) {
    return {
      total: 0,
      success: 0,
      failed: 0,
      retries: 0,
      latency: []
    };
  }
  return JSON.parse(fs.readFileSync(PATH));
}

function save(data) {
  fs.writeFileSync(PATH, JSON.stringify(data, null, 2));
}

export function recordStart(jobId) {
  const data = load();
  data.total += 1;
  data[`start_${jobId}`] = Date.now();
  save(data);
}

export function recordRetry() {
  const data = load();
  data.retries += 1;
  save(data);
}

export function recordSuccess(jobId) {
  const data = load();
  data.success += 1;

  const start = data[`start_${jobId}`];
  if (start) {
    data.latency.push(Date.now() - start);
    delete data[`start_${jobId}`];
  }

  save(data);
}

export function recordFailure(jobId) {
  const data = load();
  data.failed += 1;

  const start = data[`start_${jobId}`];
  if (start) {
    data.latency.push(Date.now() - start);
    delete data[`start_${jobId}`];
  }

  save(data);
}

export function getMetrics() {
  const data = load();

  const avgLatency =
    data.latency.length > 0
      ? data.latency.reduce((a, b) => a + b, 0) / data.latency.length
      : 0;

  return {
    total: data.total,
    success: data.success,
    failed: data.failed,
    retries: data.retries,
    successRate:
      data.total > 0 ? (data.success / data.total) * 100 : 0,
    avgLatency
  };
}
