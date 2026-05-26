import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), '..');

if (!process.versions.electron) {
  const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!existsSync(electronExe)) {
    throw new Error(`Electron executable not found: ${electronExe}`);
  }
  const result = spawnSync(electronExe, [scriptPath], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit'
  });
  process.exit(result.status ?? 1);
}

const { Worker } = await import('node:worker_threads');

const workerPath = path.join(root, 'out', 'main', 'dbWorker.js');
if (!existsSync(workerPath)) {
  throw new Error('Build output not found. Run the package or build command first.');
}

const tempRoot = mkdtempSync(path.join(tmpdir(), 'corpusviewer-smoke-'));
const paths = {
  portableRoot: tempRoot,
  dataDir: path.join(tempRoot, 'CorpusViewerData'),
  defaultCorporaDir: path.join(tempRoot, 'corpora'),
  tempDir: path.join(tempRoot, 'CorpusViewerData', 'tmp'),
  databasePath: path.join(tempRoot, 'CorpusViewerData', 'corpusviewer.sqlite')
};
mkdirSync(paths.defaultCorporaDir, { recursive: true });
mkdirSync(paths.tempDir, { recursive: true });

const samplePath = path.join(paths.defaultCorporaDir, 'sample.json');
writeFileSync(
  samplePath,
  JSON.stringify({
    metadata: { category: '테스트', year: '2026' },
    document: [
      {
        id: 'DOC-1',
        metadata: {
          topic: '음식',
          speaker: [{ id: 'P1', age: '20대', sex: 'F', occupation: '연구원' }]
        },
        utterance: [
          {
            id: 'U1',
            speaker_id: 'P1',
            form: '밥을 빨리 먹다',
            original_form: '밥을 빨리 먹다',
            tokens: [
              { surface: '밥을', lemma: '밥', pos: 'NNG' },
              { surface: '빨리', lemma: '빨리', pos: 'MAG' },
              { surface: '먹다', lemma: '먹다', pos: 'VV' }
            ]
          },
          {
            id: 'U2',
            speaker_id: 'P1',
            form: '진짜 좋다',
            original_form: '진짜 좋다'
          },
          {
            id: 'U3',
            speaker_id: 'P1',
            form: '\ue57b일신문을 읽다',
            original_form: '\ue57b일신문을 읽다',
            tokens: [{ surface: '\ue57b일신문', lemma: '\ue57b일신문', pos: 'NNG' }]
          }
        ]
      }
    ]
  }),
  'utf8'
);

const worker = new Worker(workerPath, { workerData: { paths } });
let nextId = 1;
const pending = new Map();
const jobProgress = [];

worker.on('message', (message) => {
  if (message.type === 'progress') return;
  if (message.type === 'jobProgress') {
    jobProgress.push(message.progress);
    return;
  }
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const imported = await invoke('importSources', [samplePath], 30000);
  assert(imported.length === 1 && imported[0].status === 'ready', 'Import did not finish as ready.');

  const state = await invoke('getState');
  assert(state.corpora.length === 1, 'State did not return the imported corpus.');
  assert(state.corpora[0].utteranceCount === 3, 'Import did not include the legacy Hangul smoke row.');

  const search = await invoke('search', {
    query: '[text="먹다"]',
    mode: 'cql',
    field: 'form',
    contextSize: 2,
    limit: 10,
    offset: 0,
    filters: { tokenSource: 'raw' }
  });
  assert(search.results.length === 1, 'CQL search did not return the expected result.');

  const textSearch = await invoke('search', {
    query: '진짜',
    mode: 'text',
    field: 'form',
    contextSize: 2,
    limit: 10,
    offset: 0,
    filters: { tokenSource: 'raw' }
  });
  assert(textSearch.results.length === 1, 'Text search did not return the expected result.');

  const legacyHangulSearch = await invoke('search', {
    query: 'ᄆᆡ일신문을',
    mode: 'text',
    field: 'form',
    contextSize: 2,
    limit: 10,
    offset: 0,
    filters: { tokenSource: 'raw' }
  });
  assert(legacyHangulSearch.results.length === 1, 'Legacy Hanyang PUA text was not normalized in the built worker.');

  const distanceSearch = await invoke('search', {
    query: '[text="진짜"] []{0,3} [text="좋다"]',
    mode: 'cql',
    field: 'form',
    contextSize: 2,
    limit: 10,
    offset: 0,
    filters: { tokenSource: 'raw' }
  });
  assert(distanceSearch.results.length === 1, 'Distance CQL search did not return the expected result.');

  const posSearch = await invoke('search', {
    query: '[pos="VV"]',
    mode: 'cql',
    field: 'form',
    contextSize: 2,
    limit: 10,
    offset: 0,
    filters: { tokenSource: 'provided' }
  });
  assert(posSearch.results.length === 1, 'POS CQL search did not return the expected result.');

  const csvPath = path.join(tempRoot, 'search-results.csv');
  const csvExport = await invoke('exportSearchCsv', {
    filePath: csvPath,
    request: {
      query: '.+',
      mode: 'regex',
      field: 'form',
      contextSize: 2,
      limit: 1,
      offset: 0,
      filters: { tokenSource: 'raw' }
    }
  });
  assert(csvExport.path === csvPath, 'CSV export did not return the destination path.');
  assert(csvExport.rowCount === 3, 'CSV export did not write all matching rows.');
  const csvText = readFileSync(csvPath, 'utf8');
  assert(csvText.charCodeAt(0) === 0xfeff, 'CSV export did not include the UTF-8 BOM.');
  assert(csvText.includes('corpusName,corpusId,docId'), 'CSV export header is missing.');
  assert(csvText.trim().split(/\r?\n/).length >= 2, 'CSV export did not write data rows.');

  const stats = await invoke('stats', { tokenSource: 'raw', stopwords: ['밥을'] });
  assert(stats.summary.utteranceCount === 3, 'Stats summary is incorrect.');
  assert(!stats.tokenFrequencies.some((row) => row.value === '밥을'), 'Stopword was not excluded from frequency rows.');

  const collocation = await invoke('collocation', {
    node: '먹다',
    windowSize: 2,
    minFrequency: 1,
    limit: 10,
    filters: { tokenSource: 'raw', stopwords: ['밥을'] }
  });
  assert(collocation.rows.some((row) => row.token === '빨리'), 'Collocation did not return the expected neighbor.');
  assert(!collocation.rows.some((row) => row.token === '밥을'), 'Stopword was not excluded from collocation rows.');

  const tree = await invoke('exploreTree');
  assert(tree.length === 1 && tree[0].categories.length === 1, 'Explore tree did not return the corpus.');

  const documents = await invoke('listDocuments', {
    corpusId: state.corpora[0].id,
    limit: 10,
    offset: 0
  });
  assert(documents.length === 1, 'Explore document list did not return the document.');

  const document = await invoke('getDocument', {
    corpusId: state.corpora[0].id,
    docId: documents[0].docId,
    offset: 0,
    limit: 1
  });
  assert(document.utterances.length === 1, 'Document detail did not return a paged utterance window.');
  assert(document.hasMoreUtterances === true, 'Document detail paging did not report more utterances.');
  assert(jobProgress.some((progress) => progress.type === 'import' && progress.status === 'done'), 'Import job progress was not emitted.');
  assert(jobProgress.some((progress) => progress.type === 'search' && progress.status === 'done'), 'Search job progress was not emitted.');
  assert(jobProgress.some((progress) => progress.type === 'explore' && progress.status === 'done'), 'Explore job progress was not emitted.');

  console.log('CorpusViewer worker smoke passed.');
} finally {
  await worker.terminate();
  rmSync(tempRoot, { recursive: true, force: true });
}
