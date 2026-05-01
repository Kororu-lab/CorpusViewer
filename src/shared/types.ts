export type CorpusStatus = 'ready' | 'queued' | 'running' | 'failed' | 'cancelled' | 'skipped_duplicate';

export interface CorpusRecord {
  id: string;
  name: string;
  sourcePath: string;
  sourceType: string;
  status: CorpusStatus;
  importedAt: string;
  fileCount: number;
  documentCount: number;
  utteranceCount: number;
  tokenCount: number;
  error?: string | null;
}

export interface AppState {
  portableRoot: string;
  dataDir: string;
  defaultCorporaDir: string;
  corpora: CorpusRecord[];
  filters: FilterOptions;
}

export interface FilterOptions {
  years: string[];
  categories: string[];
  topics: string[];
  speakerSexes: string[];
  speakerAges: string[];
  speakerOccupations: string[];
  corpora: Array<{ id: string; name: string }>;
}

export interface SearchFilters {
  corpusIds?: string[];
  years?: string[];
  categories?: string[];
  topics?: string[];
  speakerSexes?: string[];
  speakerAges?: string[];
  speakerOccupations?: string[];
  tokenSource?: string;
  stopwords?: string[];
}

export interface StopwordSettings {
  path: string;
  text: string;
  words: string[];
}

export type SearchMode = 'text' | 'regex' | 'cql';
export type TextField = 'form' | 'original_form';

export interface SearchRequest {
  query: string;
  mode: SearchMode;
  field: TextField;
  contextSize: number;
  limit: number;
  offset: number;
  filters: SearchFilters;
  exhaustive?: boolean;
}

export interface KwicContext {
  left: string[];
  hit: string[];
  right: string[];
}

export interface SearchResult {
  corpusId: string;
  corpusName: string;
  docId: string;
  utteranceId: string;
  speakerId: string;
  sequence: number;
  form: string;
  originalForm: string;
  topic: string;
  category: string;
  year: string;
  time?: string | null;
  start?: number | null;
  end?: number | null;
  note?: string | null;
  speakerAge?: string | null;
  speakerSex?: string | null;
  speakerOccupation?: string | null;
  kwic: KwicContext;
}

export interface SearchResponse {
  results: SearchResult[];
  hasMore: boolean;
  warnings: string[];
}

export interface SearchCsvExportRequest {
  request: SearchRequest;
  filePath: string;
}

export interface SearchCsvExportResult {
  path: string;
  rowCount: number;
}

export interface ImportProgress {
  jobId?: string;
  corpusId?: string;
  label: string;
  phase: 'queued' | 'started' | 'reading' | 'indexing' | 'finalizing' | 'done' | 'failed' | 'cancelled' | 'skipped_duplicate';
  filesDone: number;
  utterancesDone: number;
  message?: string;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type JobType = 'import' | 'search' | 'stats' | 'collocation' | 'explore' | 'metadata';

export interface JobProgress {
  jobId: string;
  type: JobType;
  phase: string;
  status: JobStatus;
  current?: number;
  total?: number;
  percent?: number;
  elapsedMs: number;
  message?: string;
  cancellable: boolean;
}

export interface StatsSummary {
  corpusCount: number;
  documentCount: number;
  utteranceCount: number;
  tokenCount: number;
  speakerCount: number;
  nonSpeechCount: number;
  corpora: CorpusRecord[];
}

export interface FrequencyRow {
  value: string;
  count: number;
}

export interface StatsResponse {
  summary: StatsSummary;
  tokenFrequencies: FrequencyRow[];
  topicDistribution: FrequencyRow[];
  categoryDistribution: FrequencyRow[];
  speakerDistribution: FrequencyRow[];
  markerDistribution: FrequencyRow[];
}

export interface CollocationRequest {
  node: string;
  windowSize: number;
  minFrequency: number;
  limit: number;
  maxOccurrences?: number;
  filters: SearchFilters;
}

export interface CollocationRow {
  token: string;
  side: 'left' | 'right';
  frequency: number;
  mi: number;
  tScore: number;
}

export interface CollocationResponse {
  nodeCount: number;
  totalTokens: number;
  rows: CollocationRow[];
  warnings: string[];
}

export interface ExploreNode {
  corpusId: string;
  corpusName: string;
  categories: Array<{
    name: string;
    count: number;
    topics: Array<{ name: string; count: number }>;
  }>;
}

export interface DocumentListRequest {
  corpusId: string;
  category?: string;
  topic?: string;
  query?: string;
  limit: number;
  offset: number;
}

export interface DocumentListItem {
  corpusId: string;
  docId: string;
  title: string;
  topic: string;
  category: string;
  date: string;
  utteranceCount: number;
}

export interface DocumentDetail {
  corpusId: string;
  docId: string;
  title: string;
  topic: string;
  category: string;
  date: string;
  metadata: Record<string, unknown>;
  speakers: Array<Record<string, unknown>>;
  utteranceOffset: number;
  utteranceTotal: number;
  hasMoreUtterances: boolean;
  utterances: Array<{
    utteranceId: string;
    speakerId: string;
    sequence: number;
    form: string;
    originalForm: string;
    time?: string | null;
    start?: number | null;
    end?: number | null;
    note?: string | null;
  }>;
}

export interface CorpusViewerApi {
  getState(): Promise<AppState>;
  openCorporaFolder(): Promise<void>;
  getStopwords(): Promise<StopwordSettings>;
  saveStopwords(text: string): Promise<StopwordSettings>;
  importDefault(): Promise<CorpusRecord[]>;
  importSources(): Promise<CorpusRecord[]>;
  cancelCurrentJob(): Promise<void>;
  cancelJob(jobId: string): Promise<void>;
  getJobState(jobId: string): Promise<JobProgress | null>;
  deleteCorpus(corpusId: string): Promise<void>;
  rebuildCorpus(corpusId: string): Promise<CorpusRecord>;
  search(request: SearchRequest): Promise<SearchResponse>;
  exportSearchCsv(request: SearchRequest): Promise<SearchCsvExportResult>;
  getStats(filters: SearchFilters): Promise<StatsResponse>;
  getCollocations(request: CollocationRequest): Promise<CollocationResponse>;
  getExploreTree(): Promise<ExploreNode[]>;
  listDocuments(request: DocumentListRequest): Promise<DocumentListItem[]>;
  getDocument(corpusId: string, docId: string, offset?: number, limit?: number): Promise<DocumentDetail>;
  onImportProgress(callback: (progress: ImportProgress) => void): () => void;
  onJobProgress(callback: (progress: JobProgress) => void): () => void;
}
