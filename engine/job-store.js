import fs from 'fs';

const PATH = '.claude/context/jobs.json';

function load() {
  if (!fs.existsSync(PATH)) return [];
  return JSON.parse(fs.readFileSync(PATH));
}

function save(data) {
  fs.writeFileSync(PATH, JSON.stringify(data, null, 2));
}

export function createJob(jobId, step) {
  const data = load();

  data.push({
    jobId,
    stepId: step.id,
    agent: step.agent,
    status: 'queued',
    result: null,
    retries: 0,
    createdAt: new Date().toISOString()
  });

  save(data);
}

export function updateJob(jobId, updates) {
  const data = load();

  const job = data.find(j => j.jobId === jobId);
  if (!job) return;

  Object.assign(job, updates, {
    updatedAt: new Date().toISOString()
  });

  save(data);
}

export function incrementRetries(jobId) {
  const data = load();
  const job = data.find(j => j.jobId === jobId);

  if (job) {
    job.retries += 1;
    save(data);
  }
}
