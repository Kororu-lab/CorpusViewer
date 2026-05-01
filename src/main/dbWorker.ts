import { parentPort, workerData } from 'node:worker_threads';
import { appendFileSync, writeFileSync } from 'node:fs';
import type {
  CollocationRequest,
  DocumentListRequest,
  ImportProgress,
  JobProgress,
  JobType,
  SearchFilters,
  SearchCsvExportRequest,
  SearchCsvExportResult,
  SearchRequest,
  SearchResult
} from '@shared/types';
import { CorpusDatabase } from './database';
import { CorpusImporter, ImportCancelledError } from './importer';
import type { AppPaths } from './paths';
import { CorpusServices } from './services';

interface WorkerRequest {
  id: number;
  action: string;
  payload?: unknown;
}

const paths = workerData.paths as AppPaths;
const role = String(workerData.role ?? 'query');
const database = new CorpusDatabase(paths.databasePath);
const services = new CorpusServices(database);
let cancelRequested = false;
let queue = Promise.resolve();
let currentJob: JobProgress | null = null;
const jobStartedAt = new Map<string, number>();

function post(message: unknown): void {
  parentPort?.postMessage(message);
}

function makeImporter(): CorpusImporter {
  return new CorpusImporter(
    database,
    (progress: ImportProgress) => {
      post({ type: 'progress', progress });
      if (currentJob) {
        postJobProgress({
          ...currentJob,
          phase: progress.phase,
          status: progress.phase === 'failed' ? 'failed' : progress.phase === 'cancelled' ? 'cancelled' : progress.phase === 'done' ? 'done' : 'running',
          current: progress.utterancesDone,
          message: progress.message ?? progress.label
        });
      }
    },
    () => cancelRequested
  );
}

function jobType(action: string): JobType {
  if (action.startsWith('import') || action === 'rebuildCorpus' || action === 'deleteCorpus') return 'import';
  if (action === 'search' || action === 'exportSearchCsv') return 'search';
  if (action === 'stats') return 'stats';
  if (action === 'collocation') return 'collocation';
  if (action === 'exploreTree' || action === 'listDocuments' || action === 'getDocument') return 'explore';
  return 'metadata';
}

function postJobProgress(progress: JobProgress): void {
  currentJob = progress.status === 'done' || progress.status === 'failed' || progress.status === 'cancelled' ? null : progress;
  post({ type: 'jobProgress', progress });
}

function beginJob(request: WorkerRequest): JobProgress {
  const type = jobType(request.action);
  const progress: JobProgress = {
    jobId: `${role}:${request.id}`,
    type,
    phase: 'started',
    status: 'running',
    elapsedMs: 0,
    message: jobMessage(type, 'started'),
    cancellable: type !== 'metadata'
  };
  jobStartedAt.set(progress.jobId, Date.now());
  currentJob = progress;
  postJobProgress(progress);
  return progress;
}

function finishJob(job: JobProgress, status: JobProgress['status'], message?: string): void {
  postJobProgress({
    ...job,
    status,
    phase: status,
    percent: status === 'done' ? 100 : job.percent,
    elapsedMs: Date.now() - (jobStartedAt.get(job.jobId) ?? Date.now()),
    message: message ?? jobMessage(job.type, status)
  });
  jobStartedAt.delete(job.jobId);
}

function updateJob(job: JobProgress, patch: Partial<JobProgress>): void {
  postJobProgress({
    ...job,
    ...patch,
    elapsedMs: Date.now() - (jobStartedAt.get(job.jobId) ?? Date.now())
  });
}

function jobMessage(type: JobType, phase: string): string {
  const labels: Record<JobType, string> = {
    import: '말뭉치 색인을 처리하는 중입니다.',
    search: '검색 중입니다.',
    stats: '통계를 계산하는 중입니다.',
    collocation: '공기어를 계산하는 중입니다.',
    explore: '탐색 데이터를 불러오는 중입니다.',
    metadata: '상태를 확인하는 중입니다.'
  };
  if (phase === 'done') return '완료되었습니다.';
  if (phase === 'failed') return '실패했습니다.';
  if (phase === 'cancelled') return '취소되었습니다.';
  return labels[type];
}

async function runAction(action: string, payload: unknown, job: JobProgress): Promise<unknown> {
  if (action === 'getState') {
    return {
      portableRoot: paths.portableRoot,
      dataDir: paths.dataDir,
      defaultCorporaDir: paths.defaultCorporaDir,
      corpora: database.listCorpora(),
      filters: database.getFilterOptions()
    };
  }

  if (action === 'importDefault') {
    cancelRequested = false;
    return makeImporter().importDefault(paths.defaultCorporaDir);
  }

  if (action === 'importSources') {
    cancelRequested = false;
    const sourcePaths = payload as string[];
    const importer = makeImporter();
    const imported = [];
    for (const sourcePath of sourcePaths) imported.push(await importer.importPath(sourcePath));
    return imported;
  }

  if (action === 'deleteCorpus') {
    database.deleteCorpus(payload as string);
    database.optimizeStorage();
    return undefined;
  }

  if (action === 'rebuildCorpus') {
    cancelRequested = false;
    const corpus = database.getCorpus(payload as string);
    if (!corpus) throw new Error('말뭉치를 찾을 수 없습니다.');
    return makeImporter().importPath(corpus.sourcePath, { corpusId: corpus.id, name: corpus.name });
  }

  if (action === 'search') return services.search(payload as SearchRequest);
  if (action === 'exportSearchCsv') {
    cancelRequested = false;
    return exportSearchCsv(payload as SearchCsvExportRequest, job);
  }
  if (action === 'stats') return services.getStats(payload as SearchFilters);
  if (action === 'collocation') return services.getCollocations(payload as CollocationRequest);
  if (action === 'exploreTree') return services.getExploreTree();
  if (action === 'listDocuments') return services.listDocuments(payload as DocumentListRequest);
  if (action === 'getDocument') {
    const { corpusId, docId, offset, limit } = payload as { corpusId: string; docId: string; offset?: number; limit?: number };
    return services.getDocument(corpusId, docId, offset, limit);
  }

  throw new Error(`알 수 없는 작업입니다: ${action}`);
}

const CSV_EXPORT_PAGE_SIZE = 1000;
const CSV_COLUMNS: Array<{ key: string; value: (row: SearchResult) => unknown }> = [
  { key: 'corpusName', value: (row) => row.corpusName },
  { key: 'corpusId', value: (row) => row.corpusId },
  { key: 'docId', value: (row) => row.docId },
  { key: 'utteranceId', value: (row) => row.utteranceId },
  { key: 'speakerId', value: (row) => row.speakerId },
  { key: 'sequence', value: (row) => row.sequence },
  { key: 'year', value: (row) => row.year },
  { key: 'category', value: (row) => row.category },
  { key: 'topic', value: (row) => row.topic },
  { key: 'time', value: (row) => row.time ?? '' },
  { key: 'start', value: (row) => row.start ?? '' },
  { key: 'end', value: (row) => row.end ?? '' },
  { key: 'speakerSex', value: (row) => row.speakerSex ?? '' },
  { key: 'speakerAge', value: (row) => row.speakerAge ?? '' },
  { key: 'speakerOccupation', value: (row) => row.speakerOccupation ?? '' },
  { key: 'kwicLeft', value: (row) => row.kwic.left.join(' ') },
  { key: 'kwicHit', value: (row) => row.kwic.hit.join(' ') },
  { key: 'kwicRight', value: (row) => row.kwic.right.join(' ') },
  { key: 'form', value: (row) => row.form },
  { key: 'originalForm', value: (row) => row.originalForm },
  { key: 'note', value: (row) => row.note ?? '' }
];

function exportSearchCsv(payload: SearchCsvExportRequest, job: JobProgress): SearchCsvExportResult {
  let offset = 0;
  let rowCount = 0;
  let hasMore = true;
  writeFileSync(payload.filePath, `\uFEFF${CSV_COLUMNS.map((column) => escapeCsv(column.key)).join(',')}\r\n`, 'utf8');

  while (hasMore) {
    if (cancelRequested) throw new ImportCancelledError();
    const page = services.search({
      ...payload.request,
      limit: CSV_EXPORT_PAGE_SIZE,
      offset,
      exhaustive: true
    });
    if (page.results.length > 0) {
      appendFileSync(payload.filePath, page.results.map(toCsvLine).join(''), 'utf8');
      rowCount += page.results.length;
      offset += page.results.length;
      updateJob(job, {
        phase: 'writing',
        current: rowCount,
        message: `CSV ${rowCount.toLocaleString()}행 저장 중`
      });
    }
    hasMore = page.hasMore;
    if (page.results.length === 0) break;
  }

  return { path: payload.filePath, rowCount };
}

function toCsvLine(row: SearchResult): string {
  return `${CSV_COLUMNS.map((column) => escapeCsv(column.value(row))).join(',')}\r\n`;
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

parentPort?.on('message', (request: WorkerRequest) => {
  if (request.action === 'cancelCurrentJob') {
    cancelRequested = true;
    post({ id: request.id, ok: true });
    return;
  }

  queue = queue
    .then(async () => {
      const job = beginJob(request);
      const result = await runAction(request.action, request.payload, job);
      finishJob(job, 'done');
      post({ id: request.id, ok: true, result });
    })
    .catch((error) => {
      if (currentJob) finishJob(currentJob, error instanceof ImportCancelledError ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error));
      post({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
});

process.once('exit', () => database.close());
