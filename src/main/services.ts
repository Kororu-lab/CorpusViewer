import type {
  CollocationRequest,
  CollocationResponse,
  DocumentDetail,
  DocumentListItem,
  DocumentListRequest,
  ExploreNode,
  FrequencyRow,
  SearchRequest,
  SearchResponse,
  SearchResult,
  StatsResponse
} from '@shared/types';
import { buildUtteranceFilterClause, CorpusDatabase } from './database';
import { findAnchor, matchCql, parseCql, type CqlElement, type SearchToken } from './cql';
import { normalizeToken } from './tokenizer';

interface UtteranceRow {
  id: number;
  corpusId: string;
  corpusName: string;
  docId: string;
  utteranceId: string;
  speakerId: string;
  sequence: number;
  form: string;
  originalForm: string;
  tokensJson: string;
  normalizedTokensJson: string;
  topic: string;
  category: string;
  year: string;
  time: string | null;
  start: number | null;
  end: number | null;
  note: string | null;
  speakerAge: string | null;
  speakerSex: string | null;
  speakerOccupation: string | null;
}

interface ProvidedTokenRow {
  tokenIndex: number;
  surface: string;
  normalized: string;
  lemma: string | null;
  pos: string | null;
}

const REGEX_SCAN_LIMIT = 250000;
const DOCUMENT_UTTERANCE_PAGE_SIZE = 500;

function normalizeCollocationOccurrenceLimit(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return Math.max(1, Math.floor(value));
}

function normalizeSqlLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return -1;
  return Math.max(1, Math.floor(value));
}

export class CorpusServices {
  constructor(private readonly database: CorpusDatabase) {}

  search(request: SearchRequest): SearchResponse {
    if (!request.query.trim()) {
      return { results: [], hasMore: false, warnings: ['검색어를 입력하세요.'] };
    }
    if (request.mode === 'cql') return this.searchCql(request);
    if (request.mode === 'regex') return this.searchRegex(request);
    return this.searchText(request);
  }

  getStats(filters: SearchRequest['filters']): StatsResponse {
    const db = this.database.db;
    const filter = buildUtteranceFilterClause(filters, 'u');
    const source = filters.tokenSource || 'raw';
    const onlyCorpus = hasOnlyCorpusFilter(filters);
    const corpusWhere = corpusStatsWhere(filters.corpusIds);
    const stopwordTermIds = this.stopwordTermIds(filters);
    const stopwordStats = termExclusionClause('token_stats.term_id', stopwordTermIds);

    const summaryBase = db
      .prepare(
        `SELECT COUNT(DISTINCT u.corpus_id) AS corpusCount,
                COUNT(DISTINCT u.corpus_id || '::' || u.doc_id) AS documentCount,
                COUNT(*) AS utteranceCount,
                COUNT(DISTINCT u.corpus_id || '::' || u.doc_id || '::' || u.speaker_id) AS speakerCount
         FROM utterances u
         ${filter.clause}`
      )
      .get(...filter.params) as {
      corpusCount: number;
      documentCount: number;
      utteranceCount: number;
      speakerCount: number;
    };

    const tokenCount = onlyCorpus
      ? scalar(
          db,
          `SELECT COALESCE(SUM(count), 0) AS value FROM token_stats WHERE source = ?${corpusWhere.sql}`,
          [source, ...corpusWhere.params]
        )
      : scalar(
          db,
          `SELECT COUNT(*) AS value
           FROM token_occurrences o
           JOIN utterances u ON u.id = o.utterance_rowid
           ${combineWhere(filter.clause, 'o.source = ?')}`,
          [...filter.params, source]
        );

    const nonSpeechCount = onlyCorpus
      ? scalar(
          db,
          `SELECT COALESCE(SUM(count), 0) AS value FROM value_stats WHERE kind = 'marker'${corpusWhere.sql}`,
          corpusWhere.params
        )
      : scalar(
          db,
          `SELECT COUNT(*) AS value
           FROM token_occurrences o
           JOIN terms t ON t.id = o.term_id
           JOIN utterances u ON u.id = o.utterance_rowid
           ${combineWhere(filter.clause, "o.source = ? AND t.value LIKE '{%' AND t.value LIKE '%}'")}`,
          [...filter.params, source]
        );

    return {
      summary: {
        corpusCount: summaryBase.corpusCount ?? 0,
        documentCount: summaryBase.documentCount ?? 0,
        utteranceCount: summaryBase.utteranceCount ?? 0,
        tokenCount,
        speakerCount: summaryBase.speakerCount ?? 0,
        nonSpeechCount,
        corpora: this.database.listCorpora()
      },
      tokenFrequencies: onlyCorpus
        ? this.frequencyRows(
            `SELECT terms.value, SUM(token_stats.count) AS count
             FROM token_stats
             JOIN terms ON terms.id = token_stats.term_id
             WHERE token_stats.source = ?${corpusWhere.sql.replace(/corpus_id/gu, 'token_stats.corpus_id')}${stopwordStats.sql}
             GROUP BY terms.value
             ORDER BY count DESC, terms.value
             LIMIT 100`,
            [source, ...corpusWhere.params, ...stopwordStats.params]
          )
        : this.dynamicTokenFrequencies(filter, source, 100, stopwordTermIds),
      topicDistribution: onlyCorpus
        ? this.valueStats('topic', corpusWhere)
        : this.groupUtterances(filter, 'u.topic', 50),
      categoryDistribution: onlyCorpus
        ? this.valueStats('category', corpusWhere)
        : this.groupUtterances(filter, 'u.category', 50),
      speakerDistribution: onlyCorpus
        ? this.valueStats('speaker', corpusWhere)
        : this.groupUtterances(filter, "COALESCE(NULLIF(u.speaker_sex, ''), '미상') || ' / ' || COALESCE(NULLIF(u.speaker_age, ''), '미상')", 50),
      markerDistribution: onlyCorpus
        ? this.valueStats('marker', corpusWhere)
        : this.dynamicMarkers(filter, source, 50)
    };
  }

  getCollocations(request: CollocationRequest): CollocationResponse {
    const normalizedNode = normalizeToken(request.node);
    if (!normalizedNode) return { nodeCount: 0, totalTokens: 0, rows: [], warnings: ['중심어를 입력하세요.'] };

    const db = this.database.db;
    const occurrenceLimit = normalizeCollocationOccurrenceLimit(request.maxOccurrences);
    const outputLimit = normalizeSqlLimit(request.limit);
    const source = request.filters.tokenSource || 'raw';
    const nodeTermId = this.database.getExistingTermId(normalizedNode);
    if (!nodeTermId) {
      return { nodeCount: 0, totalTokens: this.totalTokens(source), rows: [], warnings: ['중심어가 색인에 없습니다.'] };
    }

    const filter = buildUtteranceFilterClause(request.filters, 'u');
    const filterSql = filter.clause ? ` AND ${filter.clause.replace(/^WHERE /u, '')}` : '';
    const stopwordTermIds = this.stopwordTermIds(request.filters).filter((termId) => termId !== nodeTermId);
    const stopwordClause = termExclusionClause('c.term_id', stopwordTermIds);
    const totalTokens = this.totalTokens(source);
    const nodeCount = scalar(
      db,
      `SELECT COUNT(*) AS value
       FROM token_occurrences n
       JOIN utterances u ON u.id = n.utterance_rowid
       WHERE n.source = ? AND n.term_id = ?${filterSql}`,
      [source, nodeTermId, ...filter.params]
    );

    const rawRows = db
      .prepare(
        `WITH node AS (
           SELECT n.utterance_rowid, n.token_index
           FROM token_occurrences n
           JOIN utterances u ON u.id = n.utterance_rowid
           WHERE n.source = ? AND n.term_id = ?${filterSql}
           ORDER BY n.utterance_rowid, n.token_index
           LIMIT ?
         )
         SELECT term.value AS token,
                CASE WHEN c.token_index < n.token_index THEN 'left' ELSE 'right' END AS side,
                COUNT(*) AS frequency
         FROM node n
         JOIN token_occurrences c ON c.utterance_rowid = n.utterance_rowid
           AND c.source = ?
           AND c.token_index BETWEEN n.token_index - ? AND n.token_index + ?
           AND c.token_index <> n.token_index
         JOIN terms term ON term.id = c.term_id
         WHERE 1 = 1${stopwordClause.sql}
         GROUP BY c.term_id, side
         HAVING frequency >= ?
         ORDER BY frequency DESC, token
         LIMIT ?`
      )
      .all(
        source,
        nodeTermId,
        ...filter.params,
        occurrenceLimit ?? -1,
        source,
        request.windowSize,
        request.windowSize,
        ...stopwordClause.params,
        request.minFrequency,
        outputLimit
      ) as Array<{ token: string; side: 'left' | 'right'; frequency: number }>;

    const tokenFreq = this.lookupTokenFrequencies(rawRows.map((row) => row.token), source);
    const rows = rawRows.map((row) => {
      const collocateCount = tokenFreq.get(row.token) ?? row.frequency;
      const expected = totalTokens > 0 ? (nodeCount * collocateCount) / totalTokens : 0;
      return {
        ...row,
        mi: expected > 0 ? Math.log2(row.frequency / expected) : 0,
        tScore: row.frequency > 0 ? (row.frequency - expected) / Math.sqrt(row.frequency) : 0
      };
    });

    const warnings: string[] = [];
    if (nodeCount === 0) warnings.push('중심어가 현재 필터 범위에서 발견되지 않았습니다.');
    if (occurrenceLimit !== null && nodeCount > occurrenceLimit) {
      warnings.push(`중심어 빈도가 높아 처음 ${occurrenceLimit.toLocaleString()}회 출현만 계산했습니다. 공기어 탭의 최대 출현 수, 필터, 불용어를 조정하세요.`);
    }
    if (stopwordTermIds.length > 0) warnings.push(`${stopwordTermIds.length.toLocaleString()}개 불용어를 공기어 후보에서 제외했습니다.`);

    return { nodeCount, totalTokens, rows, warnings };
  }

  getExploreTree(): ExploreNode[] {
    const corpora = this.database.listCorpora().filter((corpus) => corpus.status === 'ready');
    const db = this.database.db;
    if (!corpora.length) return [];

    const corpusIds = corpora.map((corpus) => corpus.id);
    const placeholders = corpusIds.map(() => '?').join(', ');
    const categoryRows = db
      .prepare(
        `SELECT corpus_id AS corpusId, category AS name, count
         FROM explore_category_stats
         WHERE corpus_id IN (${placeholders})
         ORDER BY corpus_id, count DESC, category`
      )
      .all(...corpusIds) as Array<{ corpusId: string; name: string; count: number }>;
    const topicRows = db
      .prepare(
        `SELECT corpus_id AS corpusId, category, topic AS name, count
         FROM explore_topic_stats
         WHERE corpus_id IN (${placeholders})
         ORDER BY corpus_id, category, count DESC, topic`
      )
      .all(...corpusIds) as Array<{ corpusId: string; category: string; name: string; count: number }>;

    const topicsByCorpusCategory = new Map<string, Array<{ name: string; count: number }>>();
    for (const topic of topicRows) {
      const key = `${topic.corpusId}\t${topic.category}`;
      const rows = topicsByCorpusCategory.get(key) ?? [];
      if (rows.length < 100) rows.push({ name: topic.name, count: topic.count });
      topicsByCorpusCategory.set(key, rows);
    }

    const categoriesByCorpus = new Map<string, ExploreNode['categories']>();
    for (const category of categoryRows) {
      const rows = categoriesByCorpus.get(category.corpusId) ?? [];
      rows.push({
        name: category.name,
        count: category.count,
        topics: topicsByCorpusCategory.get(`${category.corpusId}\t${category.name}`) ?? []
      });
      categoriesByCorpus.set(category.corpusId, rows);
    }

    return corpora.map((corpus) => ({
      corpusId: corpus.id,
      corpusName: corpus.name,
      categories: categoriesByCorpus.get(corpus.id) ?? []
    }));
  }

  listDocuments(request: DocumentListRequest): DocumentListItem[] {
    const clauses = ['d.corpus_id = ?'];
    const params: unknown[] = [request.corpusId];
    if (request.category) {
      clauses.push('d.category = ?');
      params.push(request.category);
    }
    if (request.topic) {
      clauses.push('d.topic = ?');
      params.push(request.topic);
    }
    if (request.query) {
      clauses.push('(d.title LIKE ? OR d.topic LIKE ? OR d.doc_id LIKE ?)');
      params.push(`%${request.query}%`, `%${request.query}%`, `%${request.query}%`);
    }

    return this.database.db
      .prepare(
        `SELECT d.corpus_id AS corpusId, d.doc_id AS docId, d.title, d.topic,
                d.category, d.date, COALESCE(ds.utterance_count, 0) AS utteranceCount
         FROM documents d
         LEFT JOIN document_stats ds ON ds.corpus_id = d.corpus_id AND ds.doc_id = d.doc_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY d.doc_id
         LIMIT ? OFFSET ?`
      )
      .all(...params, request.limit, request.offset) as DocumentListItem[];
  }

  getDocument(corpusId: string, docId: string, offset = 0, limit = DOCUMENT_UTTERANCE_PAGE_SIZE): DocumentDetail {
    const db = this.database.db;
    const doc = db
      .prepare(
        `SELECT corpus_id AS corpusId, doc_id AS docId, title, topic, category, date, metadata_json AS metadataJson
         FROM documents
         WHERE corpus_id = ? AND doc_id = ?`
      )
      .get(corpusId, docId) as
      | {
          corpusId: string;
          docId: string;
          title: string;
          topic: string;
          category: string;
          date: string;
          metadataJson: string;
        }
      | undefined;

    if (!doc) throw new Error('문서를 찾을 수 없습니다.');

    const speakers = db
      .prepare(
        `SELECT metadata_json AS metadataJson
         FROM speakers
         WHERE corpus_id = ? AND doc_id = ?
         ORDER BY speaker_id`
      )
      .all(corpusId, docId)
      .map((row: any) => safeJson(row.metadataJson));

    const utterances = db
      .prepare(
        `SELECT utterance_id AS utteranceId, speaker_id AS speakerId, sequence,
                form, original_form AS originalForm, time, start, end, note
         FROM utterances
         WHERE corpus_id = ? AND doc_id = ?
         ORDER BY sequence
         LIMIT ? OFFSET ?`
      )
      .all(corpusId, docId, limit, offset) as DocumentDetail['utterances'];
    const stats = db
      .prepare('SELECT utterance_count AS utteranceCount FROM document_stats WHERE corpus_id = ? AND doc_id = ?')
      .get(corpusId, docId) as { utteranceCount: number } | undefined;
    const utteranceTotal = stats?.utteranceCount ?? utterances.length;

    return {
      corpusId: doc.corpusId,
      docId: doc.docId,
      title: doc.title,
      topic: doc.topic,
      category: doc.category,
      date: doc.date,
      metadata: safeJson(doc.metadataJson),
      speakers,
      utterances,
      utteranceOffset: offset,
      utteranceTotal,
      hasMoreUtterances: offset + utterances.length < utteranceTotal
    };
  }

  private searchText(request: SearchRequest): SearchResponse {
    const normalized = normalizeToken(request.query);
    if (!normalized) return { results: [], hasMore: false, warnings: ['검색어를 입력하세요.'] };

    const tokenExact = this.searchTextByExactToken(request, normalized);
    if (tokenExact) return tokenExact;

    if ([...request.query.trim()].length < 3) {
      return {
        results: [],
        hasMore: false,
        warnings: ['짧은 부분 문자열은 전체 스캔을 막기 위해 비활성화했습니다. CQL [text="..."] 또는 3글자 이상 검색어를 사용하세요.']
      };
    }

    return this.searchTextByFts(request);
  }

  private searchTextByExactToken(request: SearchRequest, normalized: string): SearchResponse | null {
    const source = request.filters.tokenSource || 'raw';
    const termId = this.database.getExistingTermId(normalized);
    if (!termId) return null;
    const filter = buildUtteranceFilterClause(request.filters, 'u');
    const filterSql = filter.clause ? ` AND ${filter.clause.replace(/^WHERE /u, '')}` : '';
    const rows = this.database.db
      .prepare(
        `${baseUtteranceSelect()}
         JOIN token_occurrences o ON o.utterance_rowid = u.id
         WHERE o.source = ? AND o.term_id = ?${filterSql}
         GROUP BY u.id
         ORDER BY u.id
         LIMIT ? OFFSET ?`
      )
      .all(source, termId, ...filter.params, request.limit + 1, request.offset) as UtteranceRow[];

    return {
      results: rows
        .slice(0, request.limit)
        .map((row) => this.toSearchResult(row, request.contextSize, source, { kind: 'text', value: request.query })),
      hasMore: rows.length > request.limit,
      warnings: []
    };
  }

  private searchTextByFts(request: SearchRequest): SearchResponse {
    const field = request.field === 'original_form' ? 'original_form' : 'form';
    const filter = buildUtteranceFilterClause(request.filters, 'u');
    const ftsColumn = field === 'original_form' ? 'original_form' : 'form';
    const filterSql = filter.clause ? ` AND ${filter.clause.replace(/^WHERE /u, '')}` : '';
    const rows = this.database.db
      .prepare(
        `${baseUtteranceSelect()}
         JOIN utterance_fts fts ON fts.rowid = u.id
         WHERE fts.${ftsColumn} LIKE ?${filterSql}
         ORDER BY u.id
         LIMIT ? OFFSET ?`
      )
      .all(`%${request.query}%`, ...filter.params, request.limit + 1, request.offset) as UtteranceRow[];

    return {
      results: rows
        .slice(0, request.limit)
        .map((row) => this.toSearchResult(row, request.contextSize, request.filters.tokenSource || 'raw', { kind: 'text', value: request.query })),
      hasMore: rows.length > request.limit,
      warnings: []
    };
  }

  private searchRegex(request: SearchRequest): SearchResponse {
    let regex: RegExp;
    try {
      regex = new RegExp(request.query, 'u');
    } catch {
      return { results: [], hasMore: false, warnings: ['정규식이 올바르지 않습니다.'] };
    }

    const field = request.field === 'original_form' ? 'originalForm' : 'form';
    const filter = buildUtteranceFilterClause(request.filters, 'u');
    const statement = this.database.db.prepare(`${baseUtteranceSelect()} ${filter.clause} ORDER BY u.id`);
    const results: SearchResult[] = [];
    let matched = 0;
    let hasMore = false;
    let scanned = 0;
    const scanLimit = request.exhaustive ? Number.POSITIVE_INFINITY : REGEX_SCAN_LIMIT;

    for (const row of statement.iterate(...filter.params) as Iterable<UtteranceRow>) {
      scanned += 1;
      if (!regex.test(row[field])) continue;
      regex.lastIndex = 0;
      if (matched++ < request.offset) continue;
      if (results.length >= request.limit) {
        hasMore = true;
        break;
      }
      results.push(this.toSearchResult(row, request.contextSize, request.filters.tokenSource || 'raw', { kind: 'regex', regex }));
      if (scanned >= scanLimit) {
        hasMore = true;
        break;
      }
    }

    const scanLimited = !request.exhaustive && scanned >= REGEX_SCAN_LIMIT;
    const warnings =
      scanLimited
        ? [`정규식 검색은 ${REGEX_SCAN_LIMIT.toLocaleString()}개 발화에서 일시 중단되었습니다. 다음 페이지 또는 필터를 사용하세요.`]
        : [];
    return { results, hasMore, warnings };
  }

  private searchCql(request: SearchRequest): SearchResponse {
    let elements: CqlElement[];
    try {
      elements = parseCql(request.query);
    } catch (error) {
      return { results: [], hasMore: false, warnings: [error instanceof Error ? error.message : String(error)] };
    }

    const distanceResult = this.searchCqlDistance(request, elements);
    if (distanceResult) return distanceResult;

    const needsProvidedTokens = elements.some((element) => element.field === 'pos' || element.field === 'lemma');
    const source = request.filters.tokenSource || (needsProvidedTokens ? 'provided' : 'raw');
    const filter = buildUtteranceFilterClause(request.filters, 'u');
    const anchor = findAnchor(elements);
    const anchorClause = this.anchorClause(anchor);
    if (anchor && !anchorClause) {
      return { results: [], hasMore: false, warnings: [`색인에 없는 조건입니다: ${anchor.value ?? ''}`] };
    }

    const filterSql = filter.clause ? ` AND ${filter.clause.replace(/^WHERE /u, '')}` : '';
    const anchoredCandidateLimit = request.exhaustive ? -1 : Math.max(1000, (request.offset + request.limit) * 80);
    const unanchoredCandidateLimit = request.exhaustive ? -1 : Math.max(5000, (request.offset + request.limit) * 100);
    const candidates = anchorClause
      ? (this.database.db
          .prepare(
            `${baseUtteranceSelect()}
             JOIN token_occurrences o ON o.utterance_rowid = u.id
             WHERE o.source = ? AND ${anchorClause.sql}${filterSql}
             GROUP BY u.id
             ORDER BY u.id
             LIMIT ?`
          )
          .all(source, ...anchorClause.params, ...filter.params, anchoredCandidateLimit) as UtteranceRow[])
      : (this.database.db
          .prepare(`${baseUtteranceSelect()} ${filter.clause} ORDER BY u.id LIMIT ?`)
          .all(...filter.params, unanchoredCandidateLimit) as UtteranceRow[]);

    const results: SearchResult[] = [];
    let matched = 0;
    let hasMore = false;

    for (const row of candidates) {
      const tokens = this.tokensForRow(row, source);
      const matches = matchCql(elements, tokens);
      if (!matches.length) continue;
      for (const match of matches) {
        if (matched++ < request.offset) continue;
        if (results.length >= request.limit) {
          hasMore = true;
          break;
        }
        results.push(this.toSearchResult(row, request.contextSize, source, { kind: 'tokens', start: match.start, end: match.end }));
      }
      if (hasMore) break;
    }

    const warnings =
      needsProvidedTokens && source === 'provided' && results.length === 0
        ? ['POS/lemma 조건은 제공 토큰이 있는 말뭉치에서만 결과를 반환합니다.']
        : [];
    return { results, hasMore, warnings };
  }

  private searchCqlDistance(request: SearchRequest, elements: CqlElement[]): SearchResponse | null {
    if (elements.length !== 3) return null;
    const [left, gap, right] = elements;
    if (!left.field || !right.field || gap.field || left.op !== '=' || right.op !== '=' || left.min !== 1 || left.max !== 1 || right.min !== 1 || right.max !== 1) {
      return null;
    }

    const source = request.filters.tokenSource || (left.field === 'text' && right.field === 'text' ? 'raw' : 'provided');
    const leftClause = this.exactOccurrenceClause('a', left);
    const rightClause = this.exactOccurrenceClause('b', right);
    if (!leftClause || !rightClause) {
      return { results: [], hasMore: false, warnings: ['색인에 없는 조건입니다.'] };
    }

    const filter = buildUtteranceFilterClause(request.filters, 'u');
    const filterSql = filter.clause ? ` AND ${filter.clause.replace(/^WHERE /u, '')}` : '';
    const rows = this.database.db
      .prepare(
        `${baseUtteranceSelect(', a.token_index AS matchStart, b.token_index + 1 AS matchEnd')}
         JOIN token_occurrences a ON a.utterance_rowid = u.id
         JOIN token_occurrences b ON b.utterance_rowid = u.id AND b.source = a.source
         WHERE a.source = ?
           AND ${leftClause.sql}
           AND ${rightClause.sql}
           AND b.token_index - a.token_index - 1 BETWEEN ? AND ?${filterSql}
         ORDER BY u.id, a.token_index
         LIMIT ? OFFSET ?`
      )
      .all(
        source,
        ...leftClause.params,
        ...rightClause.params,
        gap.min,
        gap.max,
        ...filter.params,
        request.limit + 1,
        request.offset
      ) as Array<UtteranceRow & { matchStart: number; matchEnd: number }>;

    return {
      results: rows
        .slice(0, request.limit)
        .map((row) =>
          this.toSearchResult(row, request.contextSize, source, {
            kind: 'tokens',
            start: row.matchStart,
            end: row.matchEnd
          })
        ),
      hasMore: rows.length > request.limit,
      warnings: []
    };
  }

  private anchorClause(anchor: CqlElement | undefined): { sql: string; params: unknown[] } | null | undefined {
    if (!anchor?.field || anchor.op !== '=' || !anchor.value) return undefined;
    if (anchor.field === 'text') {
      const termId = this.database.getExistingTermId(normalizeToken(anchor.value));
      return termId ? { sql: 'o.term_id = ?', params: [termId] } : null;
    }
    if (anchor.field === 'lemma') {
      const termId = this.database.getExistingTermId(anchor.value);
      return termId ? { sql: 'o.lemma_term_id = ?', params: [termId] } : null;
    }
    const termId = this.database.getExistingTermId(anchor.value);
    return termId ? { sql: 'o.pos_term_id = ?', params: [termId] } : null;
  }

  private exactOccurrenceClause(alias: string, element: CqlElement): { sql: string; params: unknown[] } | null {
    if (!element.field || element.op !== '=' || !element.value) return null;
    if (element.field === 'text') {
      const termId = this.database.getExistingTermId(normalizeToken(element.value));
      return termId ? { sql: `${alias}.term_id = ?`, params: [termId] } : null;
    }
    if (element.field === 'lemma') {
      const termId = this.database.getExistingTermId(element.value);
      return termId ? { sql: `${alias}.lemma_term_id = ?`, params: [termId] } : null;
    }
    const termId = this.database.getExistingTermId(element.value);
    return termId ? { sql: `${alias}.pos_term_id = ?`, params: [termId] } : null;
  }

  private toSearchResult(
    row: UtteranceRow,
    contextSize: number,
    source: string,
    match:
      | { kind: 'tokens'; start: number; end: number }
      | { kind: 'text'; value: string }
      | { kind: 'regex'; regex: RegExp }
  ): SearchResult {
    const tokens = this.tokensForRow(row, source);
    const tokenTexts = tokens.map((token) => token.surface);
    let start = 0;
    let end = tokenTexts.length || 1;

    if (match.kind === 'tokens') {
      start = match.start;
      end = match.end;
    } else if (match.kind === 'text') {
      const needle = normalizeToken(match.value);
      const found = tokens.findIndex((token) => token.normalized.includes(needle));
      if (found >= 0) {
        start = found;
        end = found + 1;
      }
    } else {
      const found = tokens.findIndex((token) => match.regex.test(token.surface) || match.regex.test(token.normalized));
      match.regex.lastIndex = 0;
      if (found >= 0) {
        start = found;
        end = found + 1;
      }
    }

    const hasTokenHit = tokenTexts.length > 0 && start < end;
    return {
      corpusId: row.corpusId,
      corpusName: row.corpusName,
      docId: row.docId,
      utteranceId: row.utteranceId,
      speakerId: row.speakerId,
      sequence: row.sequence,
      form: row.form,
      originalForm: row.originalForm,
      topic: row.topic,
      category: row.category,
      year: row.year,
      time: row.time,
      start: row.start,
      end: row.end,
      note: row.note,
      speakerAge: row.speakerAge,
      speakerSex: row.speakerSex,
      speakerOccupation: row.speakerOccupation,
      kwic: hasTokenHit
        ? {
            left: tokenTexts.slice(Math.max(0, start - contextSize), start),
            hit: tokenTexts.slice(start, end),
            right: tokenTexts.slice(end, end + contextSize)
          }
        : { left: [], hit: [row.form || row.originalForm], right: [] }
    };
  }

  private tokensForRow(row: UtteranceRow, source: string): SearchToken[] {
    if (source !== 'provided') {
      const surfaces = safeArray(row.tokensJson);
      const normalized = safeArray(row.normalizedTokensJson);
      return surfaces.map((surface, index) => ({ surface, normalized: normalized[index] ?? normalizeToken(surface) }));
    }

    const rows = this.database.db
      .prepare(
        `SELECT o.token_index AS tokenIndex, term.value AS surface, term.value AS normalized,
                lemma.value AS lemma, pos.value AS pos
         FROM token_occurrences o
         JOIN terms term ON term.id = o.term_id
         LEFT JOIN terms lemma ON lemma.id = o.lemma_term_id
         LEFT JOIN terms pos ON pos.id = o.pos_term_id
         WHERE o.utterance_rowid = ? AND o.source = 'provided'
         ORDER BY o.token_index`
      )
      .all(row.id) as ProvidedTokenRow[];

    return rows.map((token) => ({
      surface: token.surface,
      normalized: token.normalized,
      lemma: token.lemma,
      pos: token.pos
    }));
  }

  private valueStats(kind: string, corpusWhere: { sql: string; params: unknown[] }): FrequencyRow[] {
    return this.frequencyRows(
      `SELECT value, SUM(count) AS count
       FROM value_stats
       WHERE kind = ?${corpusWhere.sql}
       GROUP BY value
       ORDER BY count DESC, value
       LIMIT 100`,
      [kind, ...corpusWhere.params]
    );
  }

  private groupUtterances(filter: { clause: string; params: unknown[] }, expression: string, limit: number): FrequencyRow[] {
    return this.frequencyRows(
      `SELECT ${expression} AS value, COUNT(*) AS count
       FROM utterances u
       ${filter.clause}
       GROUP BY value
       ORDER BY count DESC, value
       LIMIT ?`,
      [...filter.params, limit]
    );
  }

  private dynamicTokenFrequencies(
    filter: { clause: string; params: unknown[] },
    source: string,
    limit: number,
    stopwordTermIds: number[]
  ): FrequencyRow[] {
    const stopwordClause = termExclusionClause('o.term_id', stopwordTermIds);
    return this.frequencyRows(
      `SELECT t.value, COUNT(*) AS count
       FROM token_occurrences o
       JOIN terms t ON t.id = o.term_id
       JOIN utterances u ON u.id = o.utterance_rowid
       ${combineWhere(filter.clause, `o.source = ?${stopwordClause.sql}`)}
       GROUP BY o.term_id
       ORDER BY count DESC, t.value
       LIMIT ?`,
      [...filter.params, source, ...stopwordClause.params, limit]
    );
  }

  private dynamicMarkers(filter: { clause: string; params: unknown[] }, source: string, limit: number): FrequencyRow[] {
    return this.frequencyRows(
      `SELECT t.value, COUNT(*) AS count
       FROM token_occurrences o
       JOIN terms t ON t.id = o.term_id
       JOIN utterances u ON u.id = o.utterance_rowid
       ${combineWhere(filter.clause, "o.source = ? AND t.value LIKE '{%' AND t.value LIKE '%}'")}
       GROUP BY o.term_id
       ORDER BY count DESC, t.value
       LIMIT ?`,
      [...filter.params, source, limit]
    );
  }

  private lookupTokenFrequencies(tokens: string[], source: string): Map<string, number> {
    const unique = Array.from(new Set(tokens)).filter(Boolean);
    if (!unique.length) return new Map();
    const rows = this.database.db
      .prepare(
        `SELECT terms.value, SUM(token_stats.count) AS count
         FROM token_stats
         JOIN terms ON terms.id = token_stats.term_id
         WHERE token_stats.source = ? AND terms.value IN (${unique.map(() => '?').join(', ')})
         GROUP BY terms.value`
      )
      .all(source, ...unique) as FrequencyRow[];
    return new Map(rows.map((row) => [row.value, row.count]));
  }

  private totalTokens(source: string): number {
    return scalar(this.database.db, 'SELECT COALESCE(SUM(count), 0) AS value FROM token_stats WHERE source = ?', [source]);
  }

  private frequencyRows(sql: string, params: unknown[]): FrequencyRow[] {
    return this.database.db.prepare(sql).all(...params) as FrequencyRow[];
  }

  private stopwordTermIds(filters: SearchRequest['filters']): number[] {
    return normalizeStopwords(filters.stopwords)
      .map((stopword) => this.database.getExistingTermId(stopword))
      .filter((termId): termId is number => termId !== null);
  }
}

function baseUtteranceSelect(extraColumns = ''): string {
  return `SELECT u.id, u.corpus_id AS corpusId, c.name AS corpusName,
                 u.doc_id AS docId, u.utterance_id AS utteranceId,
                 u.speaker_id AS speakerId, u.sequence, u.form,
                 u.original_form AS originalForm, u.tokens_json AS tokensJson,
                 u.normalized_tokens_json AS normalizedTokensJson,
                 u.topic, u.category, u.year, u.time, u.start, u.end, u.note,
                 u.speaker_age AS speakerAge, u.speaker_sex AS speakerSex,
                 u.speaker_occupation AS speakerOccupation${extraColumns}
          FROM utterances u
          JOIN corpora c ON c.id = u.corpus_id`;
}

function combineWhere(existingWhere: string, extraClause: string): string {
  if (!existingWhere) return `WHERE ${extraClause}`;
  return `${existingWhere} AND ${extraClause}`;
}

function safeJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function scalar(db: CorpusDatabase['db'], sql: string, params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { value: number | null } | undefined;
  return Number(row?.value ?? 0);
}

function normalizeStopwords(stopwords?: string[]): string[] {
  const values = (stopwords ?? [])
    .flatMap((value) => value.split(/[,\s]+/u))
    .map(normalizeToken)
    .filter(Boolean);
  return Array.from(new Set(values));
}

function termExclusionClause(column: string, termIds: number[]): { sql: string; params: number[] } {
  if (!termIds.length) return { sql: '', params: [] };
  return {
    sql: ` AND ${column} NOT IN (${termIds.map(() => '?').join(', ')})`,
    params: termIds
  };
}

function hasOnlyCorpusFilter(filters: SearchRequest['filters']): boolean {
  return !(
    filters.years?.length ||
    filters.categories?.length ||
    filters.topics?.length ||
    filters.speakerSexes?.length ||
    filters.speakerAges?.length ||
    filters.speakerOccupations?.length
  );
}

function corpusStatsWhere(corpusIds?: string[]): { sql: string; params: unknown[] } {
  const clean = (corpusIds ?? []).filter(Boolean);
  if (!clean.length) return { sql: '', params: [] };
  return {
    sql: ` AND corpus_id IN (${clean.map(() => '?').join(', ')})`,
    params: clean
  };
}
