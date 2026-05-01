import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type {
  CollocationRequest,
  CorpusRecord,
  DocumentDetail,
  DocumentListItem,
  DocumentListRequest,
  ExploreNode,
  SearchFilters,
  SearchRequest,
  SearchResponse,
  SearchCsvExportRequest,
  SearchCsvExportResult,
  StatsResponse,
  CollocationResponse,
  AppState,
  StopwordSettings
} from '@shared/types';
import type { AppPaths } from './paths';
import { readStopwords, writeStopwords } from './stopwords';
import { DatabaseWorkerClient } from './workerClient';

export function registerIpc(mainWindow: BrowserWindow, paths: AppPaths): DatabaseWorkerClient {
  const worker = new DatabaseWorkerClient(paths, mainWindow);

  ipcMain.handle('app:get-state', () => worker.invoke<AppState>('getState'));
  ipcMain.handle('app:open-corpora-folder', async () => {
    const error = await shell.openPath(paths.defaultCorporaDir);
    if (error) throw new Error(error);
  });
  ipcMain.handle('stopwords:get', () => readStopwords(paths));
  ipcMain.handle('stopwords:save', (_event, text: string) => writeStopwords(paths, text));
  ipcMain.handle('import:default', () => worker.invoke<CorpusRecord[]>('importDefault'));
  ipcMain.handle('import:sources', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '말뭉치 가져오기',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [
        { name: 'Corpus files', extensions: ['zip', 'json', 'csv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (result.canceled) return [];
    return worker.invoke<CorpusRecord[]>('importSources', result.filePaths);
  });

  ipcMain.handle('job:cancel-current', () => worker.cancelCurrentJob());
  ipcMain.handle('job:cancel', (_event, jobId: string) => worker.cancelJob(jobId));
  ipcMain.handle('job:get-state', (_event, jobId: string) => worker.getJobState(jobId));
  ipcMain.handle('corpus:delete', (_event, corpusId: string) => worker.invoke<void>('deleteCorpus', corpusId));
  ipcMain.handle('corpus:rebuild', (_event, corpusId: string) => worker.invoke<CorpusRecord>('rebuildCorpus', corpusId));
  ipcMain.handle('search:run', (_event, request: SearchRequest) => worker.invoke<SearchResponse>('search', request));
  ipcMain.handle('search:export-csv', async (_event, request: SearchRequest) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '검색 결과 CSV 저장',
      defaultPath: 'corpusviewer-search-results.csv',
      filters: [{ name: 'CSV files', extensions: ['csv'] }]
    });
    if (result.canceled || !result.filePath) return { path: '', rowCount: 0 } satisfies SearchCsvExportResult;
    return worker.invoke<SearchCsvExportResult>('exportSearchCsv', {
      request,
      filePath: result.filePath
    } satisfies SearchCsvExportRequest);
  });
  ipcMain.handle('stats:get', (_event, filters: SearchFilters) => worker.invoke<StatsResponse>('stats', filters));
  ipcMain.handle('collocation:get', (_event, request: CollocationRequest) =>
    worker.invoke<CollocationResponse>('collocation', request)
  );
  ipcMain.handle('explore:tree', () => worker.invoke<ExploreNode[]>('exploreTree'));
  ipcMain.handle('explore:documents', (_event, request: DocumentListRequest) =>
    worker.invoke<DocumentListItem[]>('listDocuments', request)
  );
  ipcMain.handle('explore:document', (_event, corpusId: string, docId: string, offset?: number, limit?: number) =>
    worker.invoke<DocumentDetail>('getDocument', { corpusId, docId, offset, limit })
  );

  return worker;
}
