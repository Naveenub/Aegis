import fs from 'fs';

const PATH = '.claude/context/memory.json';

function loadMemory() {
  if (!fs.existsSync(PATH)) return [];
  return JSON.parse(fs.readFileSync(PATH));
}

export function saveMemory(entry) {
  const data = loadMemory();
  data.push(entry);
  fs.writeFileSync(PATH, JSON.stringify(data, null, 2));
}

export function searchMemory(query) {
  const data = loadMemory();

  // simple similarity (can upgrade later to embeddings)
  return data
    .map(item => ({
      item,
      score: similarity(query, item.task + item.error)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(x => x.item);
}

function similarity(a, b) {
  const wordsA = a.toLowerCase().split(' ');
  const wordsB = b.toLowerCase().split(' ');

  const match = wordsA.filter(w => wordsB.includes(w)).length;
  return match / wordsA.length;
}
