import fs from 'fs';

const PATH = '.claude/context/workflows.json';

function load() {
  if (!fs.existsSync(PATH)) return {};
  return JSON.parse(fs.readFileSync(PATH));
}

function save(data) {
  fs.writeFileSync(PATH, JSON.stringify(data, null, 2));
}

// 🆕 create workflow
export function createWorkflow(id, tasks) {
  const data = load();

  data[id] = {
    id,
    tasks: tasks.map(t => ({
      ...t,
      status: 'pending'
    })),
    createdAt: Date.now()
  };

  save(data);
}

// 🔄 update step status
export function updateStep(workflowId, stepId, status) {
  const data = load();

  const wf = data[workflowId];
  if (!wf) return;

  const step = wf.tasks.find(t => t.id === stepId);
  if (step) step.status = status;

  save(data);
}

// 📊 get workflow
export function getWorkflow(id) {
  const data = load();
  return data[id];
}

// 🔍 get next runnable steps
export function getRunnableSteps(id) {
  const wf = getWorkflow(id);
  if (!wf) return [];

  return wf.tasks.filter(t => {
    if (t.status !== 'pending') return false;

    if (!t.dependsOn || t.dependsOn.length === 0) return true;

    return t.dependsOn.every(dep => {
      const d = wf.tasks.find(x => x.id === dep);
      return d && d.status === 'completed';
    });
  });
}
