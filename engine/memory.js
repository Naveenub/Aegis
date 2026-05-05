import fs from 'fs';

export function saveMemory(entry) {
  const path = '.claude/context/memory.json';

  let data = [];
  if (fs.existsSync(path)) {
    data = JSON.parse(fs.readFileSync(path));
  }

  data.push(entry);

  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}
