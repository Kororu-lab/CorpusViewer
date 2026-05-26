import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const releaseRoot = path.join(root, 'release');
const portableRoot = path.join(releaseRoot, 'win-unpacked');
const preservedDirs = [
  { name: 'CorpusViewerData', replaceGenerated: false },
  { name: 'GovCorpusData', replaceGenerated: false },
  { name: 'corpora', replaceGenerated: true }
];
const markerPath = path.join(releaseRoot, '.corpusviewer-data-backup.json');
const action = process.argv[2];

function assertInsidePortable(targetPath) {
  const resolvedPortableRoot = path.resolve(portableRoot);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedPortableRoot && !resolvedTarget.startsWith(`${resolvedPortableRoot}${path.sep}`)) {
    throw new Error(`Refusing to touch path outside portable folder: ${targetPath}`);
  }
}

function backup() {
  if (existsSync(markerPath)) {
    throw new Error(`A runtime data backup is already recorded at ${markerPath}. Restore it before packaging again.`);
  }

  mkdirSync(releaseRoot, { recursive: true });
  const backups = [];

  for (const dir of preservedDirs) {
    const { name, replaceGenerated } = dir;
    const dataDir = path.join(portableRoot, name);
    if (!existsSync(dataDir)) continue;
    assertInsidePortable(dataDir);
    const backupDir = path.join(releaseRoot, `.${name}.backup-${Date.now()}-${process.pid}`);
    renameSync(dataDir, backupDir);
    backups.push({ name, backupDir, replaceGenerated });
    console.log(`Preserved existing ${name} at ${backupDir}`);
  }

  if (!backups.length) {
    console.log('No existing runtime data folder to preserve.');
    return;
  }

  writeFileSync(markerPath, JSON.stringify(backups, null, 2), 'utf8');
}

function restore() {
  if (!existsSync(markerPath)) {
    console.log('No runtime data backup to restore.');
    return;
  }

  const backups = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (!Array.isArray(backups)) {
    unlinkSync(markerPath);
    throw new Error(`Backup marker has an unexpected format: ${markerPath}`);
  }

  for (const backup of backups) {
    const name = String(backup.name || '');
    const backupDir = String(backup.backupDir || '');
    const dir = preservedDirs.find((item) => item.name === name);
    if (!dir || !backupDir) {
      unlinkSync(markerPath);
      throw new Error(`Backup marker contains an invalid entry: ${markerPath}`);
    }
    if (!existsSync(backupDir)) {
      unlinkSync(markerPath);
      throw new Error(`Recorded runtime data backup is missing: ${backupDir}`);
    }

    const dataDir = path.join(portableRoot, name);
    assertInsidePortable(dataDir);
    if (existsSync(dataDir)) {
      const entries = readdirSync(dataDir);
      if (entries.length > 0 && !dir.replaceGenerated) {
        throw new Error(`Refusing to overwrite non-empty runtime data at ${dataDir}`);
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
    mkdirSync(portableRoot, { recursive: true });
    renameSync(backupDir, dataDir);
    console.log(`Restored ${name} to ${dataDir}`);
  }

  unlinkSync(markerPath);
}

if (action === 'backup') {
  backup();
} else if (action === 'restore') {
  restore();
} else {
  throw new Error('Usage: node scripts/preserve-release-data.mjs <backup|restore>');
}
