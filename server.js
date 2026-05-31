// ─── server.js — two targeted changes ────────────────────────────────────────
//
// Change 1: update the git.js import on line 24.
//
// BEFORE:
//   import { finaliseWorkflow } from './engine/git.js';
//
// AFTER:
//   import { finaliseWorkflow, removeWorkflowWorktree } from './engine/git.js';
//
//
// Change 2: replace the POST /cancel/:id handler body so that a cancelled
// workflow's worktree is cleaned up immediately (best-effort — the worktree
// may not exist yet if the workflow was cancelled before hitting the git layer).
//
// BEFORE (the entire handler, lines 216-230):
//
//   app.post('/cancel/:id', async (req, res) => {
//     try {
//       const { id } = req.params;
//       const { reason = 'user request' } = req.body ?? {};
//
//       const ok = await cancelWorkflow(id, reason);
//       if (!ok) {
//         return res.status(409).json({ error: 'Workflow not found, already cancelled, or completed' });
//       }
//
//       res.json({ status: 'cancelled', workflowId: id, reason });
//     } catch (err) {
//       res.status(500).json({ error: err.message });
//     }
//   });
//
// AFTER:

app.post('/cancel/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = 'user request' } = req.body ?? {};

    const ok = await cancelWorkflow(id, reason);
    if (!ok) {
      return res.status(409).json({ error: 'Workflow not found, already cancelled, or completed' });
    }

    // Remove the per-workflow worktree so cancelled workflows don't accumulate
    // directories on disk. Best-effort — the worktree may not have been created
    // yet (e.g. cancelled before the first step reached the git layer).
    const wf = await getWorkflow(id);
    if (wf?.tenantId) {
      removeWorkflowWorktree(id, wf.tenantId).catch(err => {
        console.warn(`[cancel] removeWorkflowWorktree failed for ${id}:`, err.message);
      });
    }

    res.json({ status: 'cancelled', workflowId: id, reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
