import fs from 'fs';

export function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;

  const backupPath = filePath + '.bak';
  fs.copyFileSync(filePath, backupPath);

  return backupPath;
}

export function restoreFile(filePath) {
  const backupPath = filePath + '.bak';

  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, filePath);
    fs.unlinkSync(backupPath);
  }
}

export function cleanupBackup(filePath) {
  const backupPath = filePath + '.bak';

  if (fs.existsSync(backupPath)) {
    fs.unlinkSync(backupPath);
  }
}
