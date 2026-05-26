import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packDir = path.join(root, '.git', 'objects', 'pack');
const TMP_PACK_PATTERN = /^tmp_pack_[A-Za-z0-9]+$/u;
const DEFAULT_MIN_AGE_MINUTES = 30;

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');
const minAgeMinutes = force ? 0 : readNumberArg('--min-age-minutes', DEFAULT_MIN_AGE_MINUTES);
const minAgeMs = minAgeMinutes * 60 * 1000;
const now = Date.now();

if (!existsSync(packDir)) {
  process.exit(0);
}

const resolvedRoot = path.resolve(root);
const resolvedPackDir = path.resolve(packDir);
const expectedPackDir = path.join(resolvedRoot, '.git', 'objects', 'pack');
if (resolvedPackDir !== expectedPackDir) {
  throw new Error(`Refusing to clean unexpected Git pack path: ${resolvedPackDir}`);
}

let removedCount = 0;
let removedBytes = 0;
let skippedFresh = 0;
let skippedOther = 0;

for (const entry of readdirSync(resolvedPackDir, { withFileTypes: true })) {
  if (!entry.isFile()) {
    skippedOther += 1;
    continue;
  }
  if (!TMP_PACK_PATTERN.test(entry.name)) {
    skippedOther += 1;
    continue;
  }

  const filePath = path.join(resolvedPackDir, entry.name);
  const stats = statSync(filePath);
  const ageMs = now - stats.mtimeMs;
  if (ageMs < minAgeMs) {
    skippedFresh += 1;
    continue;
  }

  removedCount += 1;
  removedBytes += stats.size;
  if (!dryRun) unlinkSync(filePath);
}

if (removedCount > 0 || skippedFresh > 0) {
  const action = dryRun ? 'Would remove' : 'Removed';
  console.log(
    `${action} ${removedCount} stale Git tmp_pack files (${formatBytes(removedBytes)}). ` +
      `Skipped fresh=${skippedFresh}, other=${skippedOther}.`
  );
}

function readNumberArg(name, fallback) {
  const prefix = `${name}=`;
  const arg = process.argv.slice(2).find((item) => item.startsWith(prefix));
  if (!arg) return fallback;
  const value = Number(arg.slice(prefix.length));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}: ${arg.slice(prefix.length)}`);
  }
  return value;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}
