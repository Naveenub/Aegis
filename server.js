import express from 'express';
import { runSystem } from './engine/orchestrator.js';

const app = express();
app.use(express.json());

app.post('/task', async (req, res) => {
  const { task } = req.body;

  await runSystem(task);

  res.json({ status: 'completed' });
});

app.listen(3000, () => console.log('Server running'));
