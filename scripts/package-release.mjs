import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const isWindows = process.platform === 'win32';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: options.shell ?? false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function bin(name) {
  return path.join(root, 'node_modules', '.bin', `${name}${isWindows ? '.cmd' : ''}`);
}

let failed = false;

try {
  run(process.execPath, ['scripts/cleanup-git-garbage.mjs']);
  run(process.execPath, ['scripts/preserve-release-data.mjs', 'backup']);
  run(bin('electron-vite'), ['build'], { shell: isWindows });
  run(bin('electron-builder'), ['--dir', '--win'], { shell: isWindows });
  run(process.execPath, ['scripts/prepare-portable.mjs']);
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  try {
    run(process.execPath, ['scripts/preserve-release-data.mjs', 'restore']);
  } catch (restoreError) {
    failed = true;
    console.error(restoreError instanceof Error ? restoreError.message : String(restoreError));
  }
}

if (failed) process.exit(1);
