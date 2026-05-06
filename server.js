import express from 'express';
import fs from 'fs';
import { getMetrics } from './engine/metrics.js';
import { initVectorIndex } from './engine/vector-memory.js';
import { runSystem } from './engine/orchestrator.js';

const app = express();
app.use(express.json());

/**
 * 🚀 Trigger task execution
 */
app.post('/task', async (req, res) => {
  try {
    const { task } = req.body;

    await runSystem(task);

    res.json({ status: 'submitted' }); // async system now
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📊 Metrics Dashboard
 */
app.get('/metrics', (req, res) => {
  try {
    res.json(getMetrics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📁 Job State Viewer
 */
app.get('/jobs', (req, res) => {
  try {
    const path = '.claude/context/jobs.json';

    if (!fs.existsSync(path)) {
      return res.json([]);
    }

    const data = JSON.parse(fs.readFileSync(path));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ❤️ Health Check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime()
  });
});

await initVectorIndex();

app.listen(3000, () => {
  console.log('🚀 Aegis server running on http://localhost:3000');
  console.log('📊 Metrics: http://localhost:3000/metrics');
  console.log('📁 Jobs: http://localhost:3000/jobs');
});
