import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  FileSearch,
  FolderOpen,
  FolderInput,
  LayoutList,
  Maximize2,
  Minimize2,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Users,
  Wand2,
  XCircle
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import type {
  AppState,
  CollocationResponse,
  CorpusRecord,
  DocumentDetail,
  DocumentListItem,
  ExploreNode,
  ImportProgress,
  JobProgress,
  SearchFilters,
  SearchMode,
  SearchResponse,
  StatsResponse,
  TextField
} from '@shared/types';
import { mergeSentenceGroupsIntoBundles, mergeUtterancesIntoSentences, type ExploreSentenceGroup } from './sentenceMerge';

type Tab = 'manager' | 'search' | 'stats' | 'collocation' | 'explore';
type ExploreTextUnit = 'utterance' | 'sentence' | 'bundle';
type ExploreViewMode =
  | 'streamUtterance'
  | 'streamSentence'
  | 'streamBundle'
  | 'speakerUtterance'
  | 'speakerSentence'
  | 'speakerBundle';

const emptyFilters: SearchFilters = {};

interface StopwordControlProps {
  stopwordsText: string;
  stopwordsPath: string;
  onStopwordsTextChange: (text: string) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isSpeakerExploreMode(mode: ExploreViewMode): boolean {
  return mode === 'speakerUtterance' || mode === 'speakerSentence' || mode === 'speakerBundle';
}

function exploreTextUnit(mode: ExploreViewMode): ExploreTextUnit {
  if (mode === 'streamSentence' || mode === 'speakerSentence') return 'sentence';
  if (mode === 'streamBundle' || mode === 'speakerBundle') return 'bundle';
  return 'utterance';
}

function toExploreViewMode(speakerMode: boolean, unit: ExploreTextUnit): ExploreViewMode {
  if (speakerMode) {
    if (unit === 'sentence') return 'speakerSentence';
    if (unit === 'bundle') return 'speakerBundle';
    return 'speakerUtterance';
  }
  if (unit === 'sentence') return 'streamSentence';
  if (unit === 'bundle') return 'streamBundle';
  return 'streamUtterance';
}

function withSpeakerExploreMode(mode: ExploreViewMode, speakerMode: boolean): ExploreViewMode {
  return toExploreViewMode(speakerMode, exploreTextUnit(mode));
}

function withExploreTextUnit(mode: ExploreViewMode, unit: ExploreTextUnit): ExploreViewMode {
  return toExploreViewMode(isSpeakerExploreMode(mode), unit);
}

function useStopwordFilters(stopwordsText: string): [SearchFilters, Dispatch<SetStateAction<SearchFilters>>] {
  const [filters, setFilters] = useState<SearchFilters>({ stopwords: parseStopwords(stopwordsText) });

  useEffect(() => {
    const stopwords = parseStopwords(stopwordsText);
    setFilters((current) => ({
      ...current,
      stopwords: stopwords.length ? stopwords : undefined
    }));
  }, [stopwordsText]);

  return [filters, setFilters];
}

export function App(): JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>('manager');
  const [state, setState] = useState<AppState | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobProgress>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [stopwordsText, setStopwordsText] = useState('');
  const [stopwordsPath, setStopwordsPath] = useState('');

  const refresh = useCallback(async () => {
    setState(await window.corpusViewer.getState());
  }, []);

  const saveStopwords = useCallback((text: string): void => {
    setStopwordsText(text);
    void window.corpusViewer
      .saveStopwords(text)
      .then((settings) => {
        setStopwordsPath(settings.path);
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
  }, []);

  useEffect(() => {
    void refresh();
    void window.corpusViewer
      .getStopwords()
      .then((settings) => {
        setStopwordsText(settings.text);
        setStopwordsPath(settings.path);
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
    const offImport = window.corpusViewer.onImportProgress((next) => {
      setProgress(next);
      if (next.phase === 'done' || next.phase === 'failed') {
        void refresh();
      }
    });
    const offJobs = window.corpusViewer.onJobProgress((next) => {
      setJobs((current) => ({ ...current, [next.jobId]: next }));
      if (next.status === 'done' && next.type === 'import') void refresh();
    });
    return () => {
      offImport();
      offJobs();
    };
  }, [refresh]);

  const runBusy = async (action: () => Promise<unknown>, doneMessage: string): Promise<void> => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(doneMessage);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const tabs = [
    { id: 'manager' as const, label: '말뭉치', icon: Database },
    { id: 'search' as const, label: '검색', icon: Search },
    { id: 'stats' as const, label: '통계', icon: BarChart3 },
    { id: 'collocation' as const, label: '공기어', icon: Network },
    { id: 'explore' as const, label: '탐색', icon: FileSearch }
  ];

  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <button
          className="sidebar-toggle"
          onClick={() => setSidebarCollapsed((current) => !current)}
          title={sidebarCollapsed ? '사이드바 펼치기' : '사이드바 줄이기'}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
        <div className="brand">
          <div className="brand-mark">G</div>
          <div className="brand-text">
            <h1>CorpusViewer</h1>
            <p>말뭉치 검색 도구</p>
          </div>
        </div>
        <nav className="nav-tabs">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                className={activeTab === tab.id ? 'active' : ''}
                onClick={() => setActiveTab(tab.id)}
                title={tab.label}
              >
                <Icon size={18} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="path-box">
          <span>데이터 폴더</span>
          <strong>{state?.dataDir ?? '준비 중'}</strong>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <h2>{tabs.find((tab) => tab.id === activeTab)?.label}</h2>
            <p>{subtitle(activeTab)}</p>
          </div>
          <button className="icon-button" onClick={() => void refresh()} title="새로고침">
            <RefreshCw size={18} />
          </button>
        </header>

        <JobProgressStrip jobs={jobs} />
        {progress && <ProgressStrip progress={progress} />}
        {message && <div className="message">{message}</div>}

        {activeTab === 'manager' && state && (
          <CorpusManager
            state={state}
            busy={busy}
            onImportDefault={() =>
              void runBusy(() => window.corpusViewer.importDefault(), 'corpora 폴더의 말뭉치를 가져왔습니다.')
            }
            onImportSources={() =>
              void runBusy(() => window.corpusViewer.importSources(), '선택한 말뭉치 가져오기를 완료했습니다.')
            }
            onOpenCorporaFolder={() =>
              void runBusy(() => window.corpusViewer.openCorporaFolder(), '말뭉치 폴더를 열었습니다.')
            }
            onDelete={(corpusId) => void runBusy(() => window.corpusViewer.deleteCorpus(corpusId), '말뭉치를 삭제했습니다.')}
            onRebuild={(corpusId) => void runBusy(() => window.corpusViewer.rebuildCorpus(corpusId), '색인을 다시 만들었습니다.')}
            onCancel={() => void window.corpusViewer.cancelCurrentJob()}
          />
        )}
        {activeTab === 'search' && state && (
          <SearchPanel state={state} stopwordsText={stopwordsText} stopwordsPath={stopwordsPath} onStopwordsTextChange={saveStopwords} />
        )}
        {activeTab === 'stats' && state && (
          <StatsPanel state={state} stopwordsText={stopwordsText} stopwordsPath={stopwordsPath} onStopwordsTextChange={saveStopwords} />
        )}
        {activeTab === 'collocation' && state && (
          <CollocationPanel state={state} stopwordsText={stopwordsText} stopwordsPath={stopwordsPath} onStopwordsTextChange={saveStopwords} />
        )}
        {activeTab === 'explore' && state && <ExplorePanel state={state} />}
      </main>
    </div>
  );
}

function subtitle(tab: Tab): string {
  if (tab === 'manager') return '가져오기, 색인 상태, 재색인 관리';
  if (tab === 'search') return 'CQL-lite, 정규식, KWIC 문맥 검색';
  if (tab === 'stats') return '빈도, 주제, 화자 분포';
  if (tab === 'collocation') return '좌우 문맥 기반 공기어 계산';
  return '말뭉치 > 주제 > 문서 단위 탐색';
}

function ProgressStrip({ progress }: { progress: ImportProgress }): JSX.Element {
  return (
    <div className={`progress-strip ${progress.phase}`}>
      <span>{progress.label}</span>
      <strong>{phaseLabel(progress.phase)}</strong>
      <span>파일 {progress.filesDone.toLocaleString()}개</span>
      <span>발화 {progress.utterancesDone.toLocaleString()}개</span>
      {progress.message && <em>{progress.message}</em>}
    </div>
  );
}

function JobProgressStrip({ jobs }: { jobs: Record<string, JobProgress> }): JSX.Element | null {
  const active = Object.values(jobs)
    .filter((job) => job.status === 'running' || job.status === 'queued')
    .sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
  if (!active) return null;
  const percent = active.percent !== undefined ? Math.max(0, Math.min(100, active.percent)) : undefined;
  return (
    <div className="job-progress">
      <div>
        <strong>{jobTypeLabel(active.type)}</strong>
        <span>{active.message ?? active.phase}</span>
        <em>{formatElapsed(active.elapsedMs)}</em>
      </div>
      <div className="job-progress-bar">
        <span style={{ width: `${percent ?? 35}%` }} className={percent === undefined ? 'indeterminate' : ''} />
      </div>
      {active.cancellable && (
        <button onClick={() => void window.corpusViewer.cancelJob(active.jobId)}>
          <XCircle size={16} />
          중지
        </button>
      )}
    </div>
  );
}

function jobTypeLabel(type: JobProgress['type']): string {
  return {
    import: '색인',
    search: '검색',
    stats: '통계',
    collocation: '공기어',
    explore: '탐색',
    metadata: '상태'
  }[type];
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return '0초';
  return `${Math.floor(ms / 1000).toLocaleString()}초`;
}

function phaseLabel(phase: ImportProgress['phase']): string {
  return {
    queued: '대기',
    started: '시작',
    reading: '읽는 중',
    indexing: '색인 중',
    finalizing: '마무리',
    done: '완료',
    failed: '실패',
    cancelled: '취소',
    skipped_duplicate: '중복 건너뜀'
  }[phase];
}

function CorpusManager({
  state,
  busy,
  onImportDefault,
  onImportSources,
  onOpenCorporaFolder,
  onDelete,
  onRebuild,
  onCancel
}: {
  state: AppState;
  busy: boolean;
  onImportDefault: () => void;
  onImportSources: () => void;
  onOpenCorporaFolder: () => void;
  onDelete: (corpusId: string) => void;
  onRebuild: (corpusId: string) => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <section className="workspace">
      <div className="toolbar">
        <button onClick={onOpenCorporaFolder} disabled={busy}>
          <FolderOpen size={17} />
          말뭉치 폴더 열기
        </button>
        <button onClick={onImportDefault} disabled={busy}>
          <FolderInput size={17} />
          corpora 폴더 가져오기
        </button>
        <button onClick={onImportSources} disabled={busy}>
          <Upload size={17} />
          파일/폴더 선택
        </button>
        <button onClick={onCancel} disabled={!busy}>
          <XCircle size={17} />
          취소
        </button>
      </div>
      <div className="hint-line">
        Windows 파일 탐색기로 말뭉치 ZIP을 이 폴더에 넣은 뒤 가져오세요: <strong>{state.defaultCorporaDir}</strong>
      </div>
      <div className="corpus-grid">
        {state.corpora.length === 0 && (
          <div className="empty-state">
            <Database size={32} />
            <p>아직 색인된 말뭉치가 없습니다.</p>
            <span>말뭉치 폴더 열기 버튼을 눌러 ZIP 파일을 넣고, corpora 폴더 가져오기를 실행하세요.</span>
          </div>
        )}
        {state.corpora.map((corpus) => (
          <article className="corpus-card" key={corpus.id}>
            <div className="corpus-card-head">
              <div>
                <h3>{corpus.name}</h3>
                <p>{corpus.sourcePath}</p>
              </div>
              <StatusBadge status={corpus.status} />
            </div>
            <div className="metric-row">
              <Metric label="파일" value={corpus.fileCount} />
              <Metric label="문서" value={corpus.documentCount} />
              <Metric label="발화" value={corpus.utteranceCount} />
              <Metric label="토큰" value={corpus.tokenCount} />
            </div>
            {corpus.error && <div className="error-text">{corpus.error}</div>}
            <div className="card-actions">
              <button onClick={() => onRebuild(corpus.id)} disabled={busy}>
                <Wand2 size={16} />
                재색인
              </button>
              <button className="danger" onClick={() => onDelete(corpus.id)} disabled={busy}>
                <Trash2 size={16} />
                삭제
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SearchPanel({ state, stopwordsText, stopwordsPath, onStopwordsTextChange }: { state: AppState } & StopwordControlProps): JSX.Element {
  const [query, setQuery] = useState('[text="진짜"] []{0,3} [text="좋다"]');
  const [mode, setMode] = useState<SearchMode>('cql');
  const [field, setField] = useState<TextField>('form');
  const [contextSize, setContextSize] = useState(7);
  const [filters, setFilters] = useStopwordFilters(stopwordsText);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [offset, setOffset] = useState(0);
  const searchRequestId = useRef(0);
  const pageSize = 100;

  const makeSearchRequest = (limit: number, nextOffset: number) => ({
    query,
    mode,
    field,
    contextSize,
    limit,
    offset: nextOffset,
    filters
  });

  const runSearch = async (nextOffset = 0): Promise<void> => {
    const requestId = searchRequestId.current + 1;
    searchRequestId.current = requestId;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const next = await window.corpusViewer.search(makeSearchRequest(pageSize, nextOffset));
      if (searchRequestId.current !== requestId) return;
      setResponse(next);
      setOffset(nextOffset);
    } catch (searchError) {
      if (searchRequestId.current !== requestId) return;
      setError(searchError instanceof Error ? searchError.message : String(searchError));
    } finally {
      if (searchRequestId.current === requestId) setLoading(false);
    }
  };

  const exportCsv = async (): Promise<void> => {
    setExporting(true);
    setError('');
    setNotice('');
    try {
      const result = await window.corpusViewer.exportSearchCsv({
        ...makeSearchRequest(pageSize, 0),
        exhaustive: true
      });
      if (result.path) setNotice(`${result.rowCount.toLocaleString()}개 검색 결과를 CSV로 저장했습니다: ${result.path}`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="workspace">
      <div className="search-bar">
        <select value={mode} onChange={(event) => setMode(event.target.value as SearchMode)} title="검색 모드">
          <option value="cql">CQL-lite</option>
          <option value="text">부분 문자열</option>
          <option value="regex">정규식</option>
        </select>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder='[text="먹다"]' />
        <button onClick={() => void runSearch()} disabled={loading}>
          <Search size={17} />
          검색
        </button>
        <button onClick={() => void exportCsv()} disabled={loading || exporting}>
          <Download size={17} />
          전체 결과 CSV 저장
        </button>
        <button onClick={() => void window.corpusViewer.cancelCurrentJob()} disabled={!loading && !exporting}>
          <XCircle size={17} />
          중지
        </button>
      </div>
      {loading && <div className="loading-line">검색 중입니다...</div>}
      {exporting && <div className="loading-line">CSV를 저장하는 중입니다...</div>}
      {error && <div className="warning">{error}</div>}
      {notice && <div className="message">{notice}</div>}
      <div className="query-examples">
        예: <code>[text="먹다"]</code> <code>[text~"^먹"]</code> <code>[pos="VV"]</code>{' '}
        <code>[text="진짜"] []{'{0,3}'} [text="좋다"]</code>
      </div>
      <FilterBar
        state={state}
        filters={filters}
        setFilters={setFilters}
        stopwordsText={stopwordsText}
        stopwordsPath={stopwordsPath}
        onStopwordsTextChange={onStopwordsTextChange}
        extra={
          <>
            <label>
              텍스트
              <select value={field} onChange={(event) => setField(event.target.value as TextField)}>
                <option value="form">정규화 발화</option>
                <option value="original_form">원문 발화</option>
              </select>
            </label>
            <label>
              문맥
              <input
                type="number"
                min={1}
                max={30}
                value={contextSize}
                onChange={(event) => setContextSize(Number(event.target.value))}
              />
            </label>
          </>
        }
      />
      {response?.warnings.map((warning) => (
        <div className="warning" key={warning}>
          {warning}
        </div>
      ))}
      <div className="result-list">
        {response?.results.map((result) => (
          <article className="result-row" key={`${result.utteranceId}:${result.sequence}:${result.kwic.hit.join(' ')}`}>
            <div className="result-meta">
              <strong>{result.corpusName}</strong>
              <span>{result.docId}</span>
              <span>{result.speakerId}</span>
              <span>{result.topic}</span>
              {result.time && <span>{result.time}</span>}
              {result.start !== null && result.start !== undefined && <span>{result.start.toFixed(2)}s</span>}
            </div>
            <div className="kwic">
              <span className="left">{result.kwic.left.join(' ')}</span>
              <mark>{result.kwic.hit.join(' ')}</mark>
              <span className="right">{result.kwic.right.join(' ')}</span>
            </div>
            <p>{field === 'form' ? result.form : result.originalForm}</p>
          </article>
        ))}
      </div>
      {response && (
        <div className="pager">
          <button onClick={() => void runSearch(Math.max(0, offset - pageSize))} disabled={loading || offset === 0}>
            <ChevronLeft size={16} />
            이전
          </button>
          <span>{response.results.length === 0 ? '0' : `${offset + 1} - ${offset + response.results.length}`}</span>
          <button onClick={() => void runSearch(offset + pageSize)} disabled={loading || !response.hasMore}>
            다음
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </section>
  );
}

function StatsPanel({ state, stopwordsText, stopwordsPath, onStopwordsTextChange }: { state: AppState } & StopwordControlProps): JSX.Element {
  const [filters, setFilters] = useStopwordFilters(stopwordsText);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const statsRequestId = useRef(0);
  const load = useCallback(async () => {
    const requestId = statsRequestId.current + 1;
    statsRequestId.current = requestId;
    setLoading(true);
    setError('');
    try {
      const next = await window.corpusViewer.getStats(filters);
      if (statsRequestId.current !== requestId) return;
      setStats(next);
    } catch (statsError) {
      if (statsRequestId.current !== requestId) return;
      setError(statsError instanceof Error ? statsError.message : String(statsError));
    } finally {
      if (statsRequestId.current === requestId) setLoading(false);
    }
  }, [filters]);

  return (
    <section className="workspace">
      <FilterBar
        state={state}
        filters={filters}
        setFilters={setFilters}
        stopwordsText={stopwordsText}
        stopwordsPath={stopwordsPath}
        onStopwordsTextChange={onStopwordsTextChange}
      />
      <div className="toolbar">
        <button onClick={() => void load()} disabled={loading}>
          <RefreshCw size={17} />
          새로 계산
        </button>
        <button onClick={() => void window.corpusViewer.cancelCurrentJob()} disabled={!loading}>
          <XCircle size={17} />
          중지
        </button>
      </div>
      {loading && <div className="loading-line">통계를 불러오는 중입니다...</div>}
      {error && <div className="warning">{error}</div>}
      {!stats && !loading && <div className="empty-state">필터를 확인한 뒤 새로 계산을 누르세요.</div>}
      {stats && (
        <>
          <div className="metric-row wide">
            <Metric label="말뭉치" value={stats.summary.corpusCount} />
            <Metric label="문서" value={stats.summary.documentCount} />
            <Metric label="발화" value={stats.summary.utteranceCount} />
            <Metric label="토큰" value={stats.summary.tokenCount} />
            <Metric label="화자" value={stats.summary.speakerCount} />
            <Metric label="비언어 표지" value={stats.summary.nonSpeechCount} />
          </div>
          <div className="stats-grid">
            <FrequencyTable title="토큰 빈도" rows={stats.tokenFrequencies} />
            <FrequencyTable title="주제 분포" rows={stats.topicDistribution} />
            <FrequencyTable title="범주 분포" rows={stats.categoryDistribution} />
            <FrequencyTable title="화자 분포" rows={stats.speakerDistribution} />
            <FrequencyTable title="비언어 표지" rows={stats.markerDistribution} />
          </div>
        </>
      )}
    </section>
  );
}

function CollocationPanel({ state, stopwordsText, stopwordsPath, onStopwordsTextChange }: { state: AppState } & StopwordControlProps): JSX.Element {
  const [node, setNode] = useState('진짜');
  const [windowSize, setWindowSize] = useState(5);
  const [maxOccurrences, setMaxOccurrences] = useState('');
  const [minFrequency, setMinFrequency] = useState('2');
  const [resultLimit, setResultLimit] = useState('');
  const [filters, setFilters] = useStopwordFilters(stopwordsText);
  const [response, setResponse] = useState<CollocationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const collocationRequestId = useRef(0);

  const run = async (): Promise<void> => {
    const occurrenceLimit = parseOptionalPositiveInteger(maxOccurrences);
    const frequencyLimit = parseOptionalPositiveInteger(minFrequency) || 1;
    const rowLimit = parseOptionalPositiveInteger(resultLimit);
    const requestId = collocationRequestId.current + 1;
    collocationRequestId.current = requestId;
    setLoading(true);
    setError('');
    try {
      const next = await window.corpusViewer.getCollocations({
          node,
          windowSize,
          minFrequency: frequencyLimit,
          limit: rowLimit,
          maxOccurrences: occurrenceLimit,
          filters
        });
      if (collocationRequestId.current !== requestId) return;
      setResponse(next);
    } catch (collocationError) {
      if (collocationRequestId.current !== requestId) return;
      setError(collocationError instanceof Error ? collocationError.message : String(collocationError));
    } finally {
      if (collocationRequestId.current === requestId) setLoading(false);
    }
  };
  const occurrenceLabel = labelOptionalPositiveInteger(maxOccurrences, '전체');
  const resultLimitLabel = labelOptionalPositiveInteger(resultLimit, '전체');

  return (
    <section className="workspace">
      <div className="toolbar">
        <label>
          중심어
          <input value={node} onChange={(event) => setNode(event.target.value)} />
        </label>
        <label>
          창
          <input
            type="number"
            min={1}
            value={windowSize}
            onChange={(event) => setWindowSize(Number(event.target.value))}
          />
        </label>
        <label>
          최대 출현
          <input
            type="number"
            min={1}
            step={1000}
            value={maxOccurrences}
            placeholder="비우면 전체"
            onChange={(event) => setMaxOccurrences(event.target.value)}
          />
        </label>
        <label>
          최소 빈도
          <input
            type="number"
            min={1}
            step={1}
            value={minFrequency}
            onChange={(event) => setMinFrequency(event.target.value)}
          />
        </label>
        <label>
          결과 행
          <input
            type="number"
            min={1}
            step={100}
            value={resultLimit}
            placeholder="비우면 전체"
            onChange={(event) => setResultLimit(event.target.value)}
          />
        </label>
        <button onClick={() => void run()} disabled={loading}>
          <Network size={17} />
          계산
        </button>
        <button onClick={() => void window.corpusViewer.cancelCurrentJob()} disabled={!loading}>
          <XCircle size={17} />
          중지
        </button>
      </div>
      <FilterBar
        state={state}
        filters={filters}
        setFilters={setFilters}
        stopwordsText={stopwordsText}
        stopwordsPath={stopwordsPath}
        onStopwordsTextChange={onStopwordsTextChange}
      />
      {loading && <div className="loading-line">공기어를 계산하는 중입니다...</div>}
      {error && <div className="warning">{error}</div>}
      {response && (
        <>
          <div className="hint-line">
            중심어 빈도 {response.nodeCount.toLocaleString()} / 계산 범위 {occurrenceLabel} / 결과 행 {resultLimitLabel} / 전체 토큰{' '}
            {response.totalTokens.toLocaleString()}
          </div>
          {response.warnings.map((warning) => (
            <div className="warning" key={warning}>
              {warning}
            </div>
          ))}
          <table className="data-table">
            <thead>
              <tr>
                <th>방향</th>
                <th>토큰</th>
                <th>빈도</th>
                <th>MI</th>
                <th>t-score</th>
              </tr>
            </thead>
            <tbody>
              {response.rows.map((row) => (
                <tr key={`${row.side}:${row.token}`}>
                  <td>{row.side === 'left' ? '좌' : '우'}</td>
                  <td>{row.token}</td>
                  <td>{row.frequency.toLocaleString()}</td>
                  <td>{row.mi.toFixed(3)}</td>
                  <td>{row.tScore.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function ExplorePanel({ state }: { state: AppState }): JSX.Element {
  const [tree, setTree] = useState<ExploreNode[]>([]);
  const [selected, setSelected] = useState<{ corpusId: string; category?: string; topic?: string } | null>(null);
  const [documents, setDocuments] = useState<DocumentListItem[]>([]);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [documentOffset, setDocumentOffset] = useState(0);
  const [documentsHasMore, setDocumentsHasMore] = useState(false);
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingDocuments, setLoadingDocuments] = useState(false);
  const [error, setError] = useState('');
  const treeRequestId = useRef(0);
  const documentsRequestId = useRef(0);
  const resizeState = useRef<{
    target: 'tree' | 'list';
    startX: number;
    startTreeWidth: number;
    startListWidth: number;
  } | null>(null);
  const documentPageSize = 200;
  const [treeWidth, setTreeWidth] = useState(280);
  const [listWidth, setListWidth] = useState(340);
  const [floatingDetail, setFloatingDetail] = useState(false);
  const [exploreViewMode, setExploreViewMode] = useState<ExploreViewMode>('streamUtterance');
  const exploreStyle = {
    '--explore-tree-width': `${treeWidth}px`,
    '--explore-list-width': `${listWidth}px`
  } as CSSProperties;
  const readySignature = useMemo(
    () => state.corpora.map((corpus) => `${corpus.id}:${corpus.status}:${corpus.documentCount}`).join('|'),
    [state.corpora]
  );
  const speakerColumnIds = useMemo(() => {
    if (!detail) return [];
    const fromSpeakers = detail.speakers.map((speaker) => String(speaker.id ?? '').trim()).filter(Boolean);
    const fromUtterances = detail.utterances.map((utterance) => utterance.speakerId.trim()).filter(Boolean);
    return Array.from(new Set([...fromSpeakers, ...fromUtterances]));
  }, [detail]);
  const sentenceGroups = useMemo(() => (detail ? mergeUtterancesIntoSentences(detail.utterances) : []), [detail]);
  const bundleGroups = useMemo(() => mergeSentenceGroupsIntoBundles(sentenceGroups), [sentenceGroups]);
  const effectiveViewMode: ExploreViewMode =
    speakerColumnIds.length === 0 && isSpeakerExploreMode(exploreViewMode)
      ? withSpeakerExploreMode(exploreViewMode, false)
      : exploreViewMode;
  const speakerModeActive = isSpeakerExploreMode(effectiveViewMode);
  const activeTextUnit = exploreTextUnit(effectiveViewMode);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const current = resizeState.current;
      if (!current) return;
      const dx = event.clientX - current.startX;
      if (current.target === 'tree') {
        setTreeWidth(clamp(current.startTreeWidth + dx, 220, 520));
      } else {
        setListWidth(clamp(current.startListWidth + dx, 240, 680));
      }
    };
    const handlePointerUp = (): void => {
      resizeState.current = null;
      document.body.classList.remove('is-resizing');
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.body.classList.remove('is-resizing');
    };
  }, []);

  const beginResize = (target: 'tree' | 'list', startX: number): void => {
    resizeState.current = {
      target,
      startX,
      startTreeWidth: treeWidth,
      startListWidth: listWidth
    };
    document.body.classList.add('is-resizing');
  };

  useEffect(() => {
    const requestId = treeRequestId.current + 1;
    treeRequestId.current = requestId;
    setLoadingTree(true);
    setError('');
    void window.corpusViewer
      .getExploreTree()
      .then((next) => {
        if (treeRequestId.current === requestId) setTree(next);
      })
      .catch((treeError) => {
        if (treeRequestId.current === requestId) setError(treeError instanceof Error ? treeError.message : String(treeError));
      })
      .finally(() => {
        if (treeRequestId.current === requestId) setLoadingTree(false);
      });
  }, [readySignature]);

  useEffect(() => {
    if (!selected) return;
    const requestId = documentsRequestId.current + 1;
    documentsRequestId.current = requestId;
    setDocumentOffset(0);
    setLoadingDocuments(true);
    setError('');
    void window.corpusViewer
      .listDocuments({ ...selected, limit: documentPageSize + 1, offset: 0 })
      .then((rows) => {
        if (documentsRequestId.current !== requestId) return;
        setDocuments(rows.slice(0, documentPageSize));
        setDocumentsHasMore(rows.length > documentPageSize);
        setDetail(null);
      })
      .catch((documentError) => {
        if (documentsRequestId.current === requestId) setError(documentError instanceof Error ? documentError.message : String(documentError));
      })
      .finally(() => {
        if (documentsRequestId.current === requestId) setLoadingDocuments(false);
      });
  }, [selected]);

  const loadDocumentPage = async (nextOffset: number): Promise<void> => {
    if (!selected) return;
    const requestId = documentsRequestId.current + 1;
    documentsRequestId.current = requestId;
    setLoadingDocuments(true);
    setError('');
    try {
      const rows = await window.corpusViewer.listDocuments({
        ...selected,
        limit: documentPageSize + 1,
        offset: nextOffset
      });
      if (documentsRequestId.current !== requestId) return;
      setDocuments(rows.slice(0, documentPageSize));
      setDocumentsHasMore(rows.length > documentPageSize);
      setDocumentOffset(nextOffset);
      setDetail(null);
    } catch (documentError) {
      if (documentsRequestId.current !== requestId) return;
      setError(documentError instanceof Error ? documentError.message : String(documentError));
    } finally {
      if (documentsRequestId.current === requestId) setLoadingDocuments(false);
    }
  };

  const loadDocumentDetail = async (corpusId: string, docId: string, offset = 0): Promise<void> => {
    setDetailLoading(true);
    setError('');
    try {
      setDetail(await window.corpusViewer.getDocument(corpusId, docId, offset, 500));
    } catch (documentError) {
      setError(documentError instanceof Error ? documentError.message : String(documentError));
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <section className={`explore-layout${floatingDetail ? ' floating-detail' : ''}`} style={exploreStyle}>
      <aside className="explore-tree">
        {loadingTree && <div className="loading-line">탐색 트리를 불러오는 중입니다...</div>}
        {error && <div className="warning">{error}</div>}
        {!loadingTree && tree.length === 0 && <div className="empty-state">준비된 말뭉치가 없습니다.</div>}
        {tree.map((corpus) => (
          <div key={corpus.corpusId} className="tree-block">
            <button onClick={() => setSelected({ corpusId: corpus.corpusId })}>{corpus.corpusName}</button>
            {corpus.categories.map((category) => (
              <details key={category.name}>
                <summary>{category.name || '미분류'} · {category.count}</summary>
                {category.topics.map((topic) => (
                  <button
                    key={topic.name}
                    onClick={() => setSelected({ corpusId: corpus.corpusId, category: category.name, topic: topic.name })}
                  >
                    {topic.name || '미주제'} · {topic.count}
                  </button>
                ))}
              </details>
            ))}
          </div>
        ))}
      </aside>
      <div
        className="resize-handle"
        role="separator"
        aria-label="탐색 트리 너비 조절"
        title="드래그해서 탐색 트리 너비 조절"
        onPointerDown={(event) => {
          event.preventDefault();
          beginResize('tree', event.clientX);
        }}
      />
      <div className="document-list">
        {loadingDocuments && <div className="loading-line">문서 목록을 불러오는 중입니다...</div>}
        {documents.map((doc) => (
          <button
            className="document-item"
            key={`${doc.corpusId}:${doc.docId}`}
            onClick={() => void loadDocumentDetail(doc.corpusId, doc.docId)}
          >
            <strong>{doc.docId}</strong>
            <span>{doc.topic}</span>
            <em>{doc.utteranceCount.toLocaleString()} 발화</em>
          </button>
        ))}
        {selected && (
          <div className="pager">
            <button
              onClick={() => void loadDocumentPage(Math.max(0, documentOffset - documentPageSize))}
              disabled={documentOffset === 0}
            >
              <ChevronLeft size={16} />
              이전
            </button>
            <span>{documents.length === 0 ? '0' : `${documentOffset + 1} - ${documentOffset + documents.length}`}</span>
            <button onClick={() => void loadDocumentPage(documentOffset + documentPageSize)} disabled={!documentsHasMore}>
              다음
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
      <div
        className="resize-handle"
        role="separator"
        aria-label="문서 목록 너비 조절"
        title="드래그해서 문서 목록 너비 조절"
        onPointerDown={(event) => {
          event.preventDefault();
          beginResize('list', event.clientX);
        }}
      />
      <article className="document-detail">
        {detailLoading && <div className="loading-line">문서를 불러오는 중입니다...</div>}
        {!detail && <div className="empty-state">문서를 선택하세요.</div>}
        {detail && (
          <>
            <header className="document-detail-head">
              <div>
                <h3>{detail.docId}</h3>
                <p>{detail.topic}</p>
              </div>
              <div className="detail-actions">
                <div className="segmented-control" aria-label="문서 보기 방식">
                  <button
                    className={!speakerModeActive ? 'active' : ''}
                    onClick={() => setExploreViewMode((current) => withSpeakerExploreMode(current, false))}
                    title="일반 발화 보기"
                  >
                    <LayoutList size={16} />
                    일반
                  </button>
                  <button
                    className={speakerModeActive ? 'active' : ''}
                    onClick={() => setExploreViewMode((current) => withSpeakerExploreMode(current, true))}
                    title="화자별 컬럼 보기"
                  >
                    <Users size={16} />
                    화자별
                  </button>
                </div>
                <div className="segmented-control" aria-label="본문 표시 단위">
                  <button
                    className={activeTextUnit === 'utterance' ? 'active' : ''}
                    onClick={() => setExploreViewMode((current) => withExploreTextUnit(current, 'utterance'))}
                    title="발화 단위로 본문 보기"
                  >
                    발화
                  </button>
                  <button
                    className={activeTextUnit === 'sentence' ? 'active' : ''}
                    onClick={() => setExploreViewMode((current) => withExploreTextUnit(current, 'sentence'))}
                    title="문장 단위로 본문 보기"
                  >
                    문장
                  </button>
                  <button
                    className={activeTextUnit === 'bundle' ? 'active' : ''}
                    onClick={() => setExploreViewMode((current) => withExploreTextUnit(current, 'bundle'))}
                    title="짧은 같은 화자 발화를 더 크게 묶어 보기"
                  >
                    묶음
                  </button>
                </div>
                <button onClick={() => setFloatingDetail((current) => !current)}>
                  {floatingDetail ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  {floatingDetail ? '고정 보기' : '본문 크게 띄우기'}
                </button>
              </div>
            </header>
            <div className="speaker-strip">
              {detail.speakers.map((speaker, index) => (
                <span key={index}>
                  {String(speaker.id ?? '')} {String(speaker.sex ?? '')} {String(speaker.age ?? '')}
                </span>
              ))}
            </div>
            <div className="pager">
              <button
                onClick={() => void loadDocumentDetail(detail.corpusId, detail.docId, Math.max(0, detail.utteranceOffset - 500))}
                disabled={detailLoading || detail.utteranceOffset === 0}
              >
                <ChevronLeft size={16} />
                이전 발화
              </button>
              <span>
                {detail.utteranceOffset + 1} - {detail.utteranceOffset + detail.utterances.length} / {detail.utteranceTotal.toLocaleString()}
              </span>
              <button
                onClick={() => void loadDocumentDetail(detail.corpusId, detail.docId, detail.utteranceOffset + 500)}
                disabled={detailLoading || !detail.hasMoreUtterances}
              >
                다음 발화
                <ChevronRight size={16} />
              </button>
            </div>
            <ExploreDocumentBody
              key={`${effectiveViewMode}:${detail.docId}:${detail.utteranceOffset}`}
              detail={detail}
              sentenceGroups={sentenceGroups}
              bundleGroups={bundleGroups}
              speakerIds={speakerColumnIds}
              viewMode={effectiveViewMode}
            />
          </>
        )}
      </article>
    </section>
  );
}

function ExploreDocumentBody({
  detail,
  sentenceGroups,
  bundleGroups,
  speakerIds,
  viewMode
}: {
  detail: DocumentDetail;
  sentenceGroups: ExploreSentenceGroup[];
  bundleGroups: ExploreSentenceGroup[];
  speakerIds: string[];
  viewMode: ExploreViewMode;
}): JSX.Element {
  if (viewMode === 'streamSentence') return <SentenceStream groups={sentenceGroups} />;
  if (viewMode === 'streamBundle') return <SentenceStream groups={bundleGroups} mergeMode="bundle" />;
  if (viewMode === 'speakerUtterance') return <SpeakerUtteranceTable detail={detail} speakerIds={speakerIds} />;
  if (viewMode === 'speakerSentence') return <SpeakerSentenceTable groups={sentenceGroups} speakerIds={speakerIds} />;
  if (viewMode === 'speakerBundle') return <SpeakerSentenceTable groups={bundleGroups} speakerIds={speakerIds} mergeMode="bundle" />;
  return <UtteranceStream detail={detail} />;
}

function timeLabelForDisplay(utterance: DocumentDetail['utterances'][number]): string {
  if (utterance.time) return utterance.time;
  if (utterance.start !== null && utterance.start !== undefined) return `${utterance.start.toFixed(2)}s`;
  return '';
}

function UtteranceStream({ detail }: { detail: DocumentDetail }): JSX.Element {
  return (
    <div className="utterance-stream">
      {detail.utterances.map((utterance) => (
        <div className="utterance" key={utterance.utteranceId}>
          <span>{utterance.sequence}</span>
          <strong>{utterance.speakerId}</strong>
          <p>{utterance.form || utterance.originalForm}</p>
          <em>{timeLabelForDisplay(utterance)}</em>
        </div>
      ))}
    </div>
  );
}

type MergedTextMode = 'sentence' | 'bundle';

function mergedGroupLabel(group: ExploreSentenceGroup, mode: MergedTextMode): string {
  if (mode === 'bundle' && (group.sentenceCount ?? 1) > 1) return `${(group.sentenceCount ?? 1).toLocaleString()}개 문장 묶음`;
  if (group.utteranceCount > 1) return `${group.utteranceCount.toLocaleString()}개 발화 병합`;
  return '';
}

function MergedGroupMeta({ group, mode }: { group: ExploreSentenceGroup; mode: MergedTextMode }): JSX.Element | null {
  const label = mergedGroupLabel(group, mode);
  return label ? <small>{label}</small> : null;
}

function SentenceStream({ groups, mergeMode = 'sentence' }: { groups: ExploreSentenceGroup[]; mergeMode?: MergedTextMode }): JSX.Element {
  return (
    <div className="sentence-stream">
      {groups.map((group) => (
        <div className="sentence-row" key={group.id}>
          <span>{formatSequenceRange(group.startSequence, group.endSequence)}</span>
          <strong>{group.speakerId}</strong>
          <div className="merged-sentence">
            <p>{group.text}</p>
            <MergedGroupMeta group={group} mode={mergeMode} />
          </div>
          <em>{group.timeLabel}</em>
        </div>
      ))}
    </div>
  );
}

function SpeakerUtteranceTable({ detail, speakerIds }: { detail: DocumentDetail; speakerIds: string[] }): JSX.Element {
  const safeSpeakerIds = speakerIds.length ? speakerIds : [''];
  return (
    <div className="speaker-column-stream" style={{ '--speaker-count': String(safeSpeakerIds.length) } as CSSProperties}>
      <div className="speaker-column-heading sequence-heading">순서</div>
      {safeSpeakerIds.map((speakerId) => (
        <div className="speaker-column-heading" key={`speaker:${speakerId}`}>
          {speakerId || '미상'}
        </div>
      ))}
      {detail.utterances.map((utterance, utteranceIndex) => {
        const knownSpeaker = safeSpeakerIds.includes(utterance.speakerId);
        const speakerIndex = knownSpeaker ? safeSpeakerIds.indexOf(utterance.speakerId) : 0;
        const row = utteranceIndex + 2;
        return (
          <Fragment key={utterance.utteranceId}>
            <div className="speaker-row-index" style={{ gridColumn: 1, gridRow: row } as CSSProperties}>
              <strong>{utterance.sequence}</strong>
              <span>{timeLabelForDisplay(utterance)}</span>
            </div>
            <div className="speaker-utterance" style={{ gridColumn: speakerIndex + 2, gridRow: row } as CSSProperties}>
              <p>{utterance.form || utterance.originalForm}</p>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

function formatSequenceRange(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

function SpeakerSentenceTable({
  groups,
  speakerIds,
  mergeMode = 'sentence'
}: {
  groups: ExploreSentenceGroup[];
  speakerIds: string[];
  mergeMode?: MergedTextMode;
}): JSX.Element {
  const safeSpeakerIds = speakerIds.length ? speakerIds : [''];
  const gridMinWidth = 92 + safeSpeakerIds.length * 230;
  return (
    <div
      className="speaker-sentence-table"
      style={
        {
          '--speaker-count': String(safeSpeakerIds.length),
          '--speaker-grid-min-width': `${gridMinWidth}px`
        } as CSSProperties
      }
    >
      <div className="speaker-sentence-header">
        <div className="speaker-sentence-heading sequence-heading">순서</div>
        {safeSpeakerIds.map((speakerId) => (
          <div className="speaker-sentence-heading" key={`sentence-speaker:${speakerId}`}>
            {speakerId || '미상'}
          </div>
        ))}
      </div>
      {groups.map((group) => {
        const knownSpeaker = safeSpeakerIds.includes(group.speakerId);
        return (
          <div className="speaker-sentence-row-grid" key={group.id}>
            <div className="speaker-sentence-index">
              <strong>{formatSequenceRange(group.startSequence, group.endSequence)}</strong>
              <span>{group.timeLabel}</span>
            </div>
            {safeSpeakerIds.map((speakerId, speakerIndex) => {
              const isActive = speakerId === group.speakerId || (!knownSpeaker && speakerIndex === 0);
              return (
                <div className={`speaker-sentence-cell${isActive ? ' active' : ''}`} key={`${group.id}:${speakerId || speakerIndex}`}>
                  {isActive && (
                    <div className="speaker-sentence-card">
                      <p>{group.text}</p>
                      <MergedGroupMeta group={group} mode={mergeMode} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function FilterBar({
  state,
  filters,
  setFilters,
  stopwordsText,
  stopwordsPath,
  onStopwordsTextChange,
  extra
}: {
  state: AppState;
  filters: SearchFilters;
  setFilters: (filters: SearchFilters) => void;
  stopwordsText: string;
  stopwordsPath: string;
  onStopwordsTextChange: (text: string) => void;
  extra?: JSX.Element;
}): JSX.Element {
  const [stopwordEditorOpen, setStopwordEditorOpen] = useState(false);
  const [stopwordDraft, setStopwordDraft] = useState(stopwordsText);
  const stopwordWords = useMemo(() => parseStopwords(stopwordsText), [stopwordsText]);
  const setOne = (key: keyof SearchFilters, value: string): void => {
    setFilters({ ...filters, [key]: value ? [value] : undefined });
  };
  const openStopwordEditor = (): void => {
    setStopwordDraft(stopwordsText);
    setStopwordEditorOpen(true);
  };
  const saveStopwordDraft = (): void => {
    const text = stopwordDraft;
    const stopwords = parseStopwords(text);
    setFilters({ ...filters, stopwords: stopwords.length ? stopwords : undefined });
    onStopwordsTextChange(text);
    setStopwordEditorOpen(false);
  };
  return (
    <>
      <div className="filter-bar">
        <label>
          말뭉치
          <select value={filters.corpusIds?.[0] ?? ''} onChange={(event) => setOne('corpusIds', event.target.value)}>
            <option value="">전체</option>
            {state.filters.corpora.map((corpus) => (
              <option value={corpus.id} key={corpus.id}>
                {corpus.name}
              </option>
            ))}
          </select>
        </label>
        <SelectFilter label="연도" value={filters.years?.[0]} values={state.filters.years} onChange={(value) => setOne('years', value)} />
        <SelectFilter label="범주" value={filters.categories?.[0]} values={state.filters.categories} onChange={(value) => setOne('categories', value)} />
        <SelectFilter label="주제" value={filters.topics?.[0]} values={state.filters.topics} onChange={(value) => setOne('topics', value)} />
        <SelectFilter label="성별" value={filters.speakerSexes?.[0]} values={state.filters.speakerSexes} onChange={(value) => setOne('speakerSexes', value)} />
        <SelectFilter label="연령" value={filters.speakerAges?.[0]} values={state.filters.speakerAges} onChange={(value) => setOne('speakerAges', value)} />
        <label>
          토큰
          <select value={filters.tokenSource ?? 'raw'} onChange={(event) => setFilters({ ...filters, tokenSource: event.target.value })}>
            <option value="raw">원시</option>
            <option value="provided">제공 POS</option>
          </select>
        </label>
        <div className="stopword-display" title={stopwordsPath ? `파일: ${stopwordsPath}` : '불용어 파일을 준비하는 중입니다.'}>
          <span>불용어</span>
          <strong>{stopwordWords.length ? stopwordWords.slice(0, 8).join(', ') : '없음'}</strong>
          {stopwordWords.length > 8 && <em>외 {(stopwordWords.length - 8).toLocaleString()}개</em>}
          <button type="button" onClick={openStopwordEditor}>
            변경
          </button>
        </div>
        {extra}
      </div>
      {stopwordEditorOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="stopword-modal" role="dialog" aria-modal="true" aria-label="불용어 편집">
            <header>
              <div>
                <h3>불용어 편집</h3>
                <p>{stopwordsPath || '불용어 파일을 준비하는 중입니다.'}</p>
              </div>
              <button className="icon-button" onClick={() => setStopwordEditorOpen(false)} title="닫기">
                <XCircle size={17} />
              </button>
            </header>
            <textarea
              value={stopwordDraft}
              onChange={(event) => setStopwordDraft(event.target.value)}
              placeholder="은, 는, 이, 가"
              autoFocus
            />
            <footer>
              <span>쉼표, 공백, 줄바꿈으로 구분합니다.</span>
              <button onClick={() => setStopwordEditorOpen(false)}>취소</button>
              <button onClick={saveStopwordDraft}>저장</button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

function parseStopwords(value: string): string[] {
  return Array.from(new Set(value.split(/[,\s]+/u).map((item) => item.trim()).filter(Boolean)));
}

function parseOptionalPositiveInteger(value: string): number {
  if (!value.trim()) return 0;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function labelOptionalPositiveInteger(value: string, emptyLabel: string): string {
  const parsed = parseOptionalPositiveInteger(value);
  return parsed > 0 ? parsed.toLocaleString() : emptyLabel;
}

function SelectFilter({
  label,
  value,
  values,
  onChange
}: {
  label: string;
  value?: string;
  values: string[];
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label>
      {label}
      <select value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
        <option value="">전체</option>
        {values.map((item) => (
          <option value={item} key={item}>
            {item}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusBadge({ status }: { status: CorpusRecord['status'] }): JSX.Element {
  const labels: Record<CorpusRecord['status'], string> = {
    ready: '준비',
    queued: '대기',
    running: '가져오는 중',
    failed: '실패',
    cancelled: '취소',
    skipped_duplicate: '중복 건너뜀'
  };
  return <span className={`status ${status}`}>{labels[status]}</span>;
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function FrequencyTable({ title, rows }: { title: string; rows: Array<{ value: string; count: number }> }): JSX.Element {
  return (
    <section className="table-panel">
      <h3>{title}</h3>
      <table className="data-table compact">
        <tbody>
          {rows.map((row) => (
            <tr key={row.value}>
              <td>{row.value || '미상'}</td>
              <td>{row.count.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
