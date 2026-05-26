import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const portableRoot = path.join(root, 'release', 'win-unpacked');
const output = path.join(portableRoot, 'corpora');

mkdirSync(output, { recursive: true });

const zipFiles = readdirSync(root)
  .filter((name) => /^NIKL_.*\.zip$/u.test(name))
  .map((name) => path.join(root, name));

for (const source of zipFiles) {
  const target = path.join(output, path.basename(source));
  const sourceSize = statSync(source).size;
  const targetSize = existsSync(target) ? statSync(target).size : -1;
  if (sourceSize !== targetSize) {
    copyFileSync(source, target);
  }
}

console.log(`Copied ${zipFiles.length} corpus zip file(s) to ${output}`);
