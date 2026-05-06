export async function runDAG(tasks, runStep) {
  const completed = new Set();
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const jobMap = new Map();

  while (completed.size < tasks.length) {
    const runnable = tasks.filter(t =>
      !completed.has(t.id) &&
      t.depends_on.every(dep => completed.has(dep))
    );

    if (runnable.length === 0) {
      throw new Error('Circular dependency detected');
    }

    // Schedule jobs
    const jobs = await Promise.all(
      runnable.map(async (task) => {
        const job = await runStep(task); // returns job
        jobMap.set(task.id, job);
        return { task, job };
      })
    );

    // WAIT FOR COMPLETION (THIS IS THE FIX)
    await Promise.all(
      jobs.map(async ({ task, job }) => {
        await job.waitUntilFinished(taskQueue.client);
        completed.add(task.id);
      })
    );
  }
}
