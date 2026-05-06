export async function runDAG(tasks, runStep) {
  const completed = new Set();
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  while (completed.size < tasks.length) {
    // find runnable tasks
    const runnable = tasks.filter(t =>
      !completed.has(t.id) &&
      t.depends_on.every(dep => completed.has(dep))
    );

    if (runnable.length === 0) {
      throw new Error('Circular dependency detected');
    }

    // run in parallel
    await Promise.all(
      runnable.map(async (task) => {
        await runStep(task);
        completed.add(task.id);
      })
    );
  }
}
