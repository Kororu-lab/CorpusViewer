import { contextBridge, ipcRenderer } from 'electron';
import type {
  CollocationRequest,
  DocumentListRequest,
  CorpusViewerApi,
  ImportProgress,
  JobProgress,
  SearchFilters,
  SearchRequest,
  StopwordSettings
} from '@shared/types';

const api: CorpusViewerApi = {
  getState: () => ipcRenderer.invoke('app:get-state'),
  openCorporaFolder: () => ipcRenderer.invoke('app:open-corpora-folder'),
  getStopwords: () => ipcRenderer.invoke('stopwords:get') as Promise<StopwordSettings>,
  saveStopwords: (text: string) => ipcRenderer.invoke('stopwords:save', text) as Promise<StopwordSettings>,
  importDefault: () => ipcRenderer.invoke('import:default'),
  importSources: () => ipcRenderer.invoke('import:sources'),
  cancelCurrentJob: () => ipcRenderer.invoke('job:cancel-current'),
  cancelJob: (jobId: string) => ipcRenderer.invoke('job:cancel', jobId),
  getJobState: (jobId: string) => ipcRenderer.invoke('job:get-state', jobId),
  deleteCorpus: (corpusId: string) => ipcRenderer.invoke('corpus:delete', corpusId),
  rebuildCorpus: (corpusId: string) => ipcRenderer.invoke('corpus:rebuild', corpusId),
  search: (request: SearchRequest) => ipcRenderer.invoke('search:run', request),
  exportSearchCsv: (request: SearchRequest) => ipcRenderer.invoke('search:export-csv', request),
  getStats: (filters: SearchFilters) => ipcRenderer.invoke('stats:get', filters),
  getCollocations: (request: CollocationRequest) => ipcRenderer.invoke('collocation:get', request),
  getExploreTree: () => ipcRenderer.invoke('explore:tree'),
  listDocuments: (request: DocumentListRequest) => ipcRenderer.invoke('explore:documents', request),
  getDocument: (corpusId: string, docId: string, offset?: number, limit?: number) =>
    ipcRenderer.invoke('explore:document', corpusId, docId, offset, limit),
  onImportProgress: (callback: (progress: ImportProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ImportProgress): void => callback(progress);
    ipcRenderer.on('import:progress', listener);
    return () => ipcRenderer.removeListener('import:progress', listener);
  },
  onJobProgress: (callback: (progress: JobProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: JobProgress): void => callback(progress);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  }
};

contextBridge.exposeInMainWorld('corpusViewer', api);
