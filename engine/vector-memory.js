import fs from 'fs';
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const PATH = '.claude/context/vector-memory.json';

function load() {
  if (!fs.existsSync(PATH)) return [];
  return JSON.parse(fs.readFileSync(PATH));
}

function save(data) {
  fs.writeFileSync(PATH, JSON.stringify(data, null, 2));
}

// 🔢 cosine similarity
function cosine(a, b) {
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return dot / (magA * magB);
}

// 🧠 create embedding
async function embed(text) {
  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  });

  return res.data[0].embedding;
}

// ➕ store memory
export async function storeMemory(text, patch) {
  const data = load();

  const vector = await embed(text);

  data.push({
    text,
    patch,
    vector,
    createdAt: new Date().toISOString()
  });

  save(data);
}

// 🔍 search similar
export async function searchMemory(query, topK = 3) {
  const data = load();
  if (data.length === 0) return [];

  const queryVec = await embed(query);

  const scored = data.map(item => ({
    ...item,
    score: cosine(queryVec, item.vector)
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
