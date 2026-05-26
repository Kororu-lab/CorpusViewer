import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), '..');

if (!process.versions.electron) {
  const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!existsSync(electronExe)) throw new Error(`Electron executable not found: ${electronExe}`);
  const result = spawnSync(electronExe, [scriptPath], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit'
  });
  process.exit(result.status ?? 1);
}

const workerPath = path.join(root, 'out', 'main', 'dbWorker.js');
if (!existsSync(workerPath)) throw new Error(`Worker not found: ${workerPath}`);

const sources = [
  'Historical Korean Corpus 2024_v1.0.zip',
  'NIKL_CI_2023_v1.1.zip',
  'NIKL_Historical Korean Corpus 2023_v2.0.zip',
  'NIKL_IU_2023_v1.0.zip'
].map((name) => path.join(root, 'new', name));

for (const source of sources) {
  if (!existsSync(source)) throw new Error(`Missing source: ${source}`);
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'govcorpus-new-verify-'));
const paths = {
  portableRoot: tempRoot,
  dataDir: path.join(tempRoot, 'GovCorpusData'),
  defaultCorporaDir: path.join(tempRoot, 'corpora'),
  tempDir: path.join(tempRoot, 'GovCorpusData', 'tmp'),
  databasePath: path.join(tempRoot, 'GovCorpusData', 'govcorpus.sqlite')
};
mkdirSync(paths.defaultCorporaDir, { recursive: true });
mkdirSync(paths.tempDir, { recursive: true });

const worker = new Worker(workerPath, { workerData: { paths, role: 'import' } });
let nextId = 1;
const pending = new Map();
let lastProgressAt = 0;

worker.on('message', (message) => {
  if (message.type === 'progress') {
    const now = Date.now();
    if (now - lastProgressAt > 5000 || message.progress.phase === 'done' || message.progress.phase === 'failed') {
      lastProgressAt = now;
      console.log(
        `[progress] ${message.progress.phase} ${message.progress.label} files=${message.progress.filesDone} utterances=${message.progress.utterancesDone} ${message.progress.message || ''}`
      );
    }
    return;
  }
  if (message.type === 'jobProgress') return;
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  clearTimeout(item.timer);
  if (message.ok) item.resolve(message.result);
  else item.reject(new Error(message.error ?? 'Worker action failed.'));
});

worker.on('error', (error) => {
  for (const item of pending.values()) item.reject(error);
  pending.clear();
});

function invoke(action, payload, timeoutMs = 15000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${action}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, action, payload });
  });
}

try {
  const imported = await invoke('importSources', sources, 30 * 60 * 1000);
  console.log('imported');
  for (const corpus of imported) {
    console.log(
      JSON.stringify({
        name: corpus.name,
        status: corpus.status,
        files: corpus.fileCount,
        docs: corpus.documentCount,
        utterances: corpus.utteranceCount,
        tokens: corpus.tokenCount,
        error: corpus.error
      })
    );
  }

  const state = await invoke('getState', undefined, 60000);
  for (const item of [
    { label: 'old-korean', query: 'ᄒᆞᆫ' },
    { label: 'hanja', query: '歌曲源流' },
    { label: 'modern', query: '국민지원금' },
    { label: 'iu', query: '엠생되는거' }
  ]) {
    const result = await invoke(
      'search',
      {
        query: item.query,
        mode: 'text',
        field: 'form',
        contextSize: 2,
        limit: 5,
        offset: 0,
        filters: { tokenSource: 'raw' }
      },
      120000
    );
    console.log(JSON.stringify({ search: item.label, results: result.results.length, warning: result.warnings?.[0] || '' }));
  }
  console.log(JSON.stringify({ tempRoot, corpora: state.corpora.length }));
} finally {
  await worker.terminate();
  rmSync(tempRoot, { recursive: true, force: true });
}
