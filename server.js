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

// ─── Change 3: add GET /workflows listing endpoint ────────────────────────────
//
// Add this import alongside the other workflow-store imports at the top of
// server.js (where cancelWorkflow, getWorkflow, etc. are already imported):
//
//   import { listWorkflows } from './engine/workflow-store.js';
//
// Then add this route — it can go anywhere after the express app is created,
// conventionally next to the other GET /workflow/:id route.

/**
 * GET /workflows
 *
 * Query params (all optional):
 *   status    — filter by status: running | paused | cancelled | completed | failed | needs-review
 *   tenantId  — filter by tenant
 *   limit     — max results (default 50, max 200)
 *   cursor    — pagination cursor returned by a previous call ('0' or omit for first page)
 *
 * Response:
 *   { workflows: [...], nextCursor: "<string>" }
 *   nextCursor === '0' means all pages have been fetched.
 *
 * Example:
 *   GET /workflows?status=running&limit=20
 *   GET /workflows?status=failed&tenantId=acme&cursor=<prev_cursor>
 */
app.get('/workflows', async (req, res) => {
  try {
    const {
      status   = null,
      tenantId = null,
      cursor   = '0'
    } = req.query;

    const limit = Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 200);

    const result = await listWorkflows({ status, tenantId, limit, cursor });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
