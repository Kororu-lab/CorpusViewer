import Database from 'better-sqlite3';
import { existsSync, renameSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import type { CorpusRecord, CorpusStatus, FilterOptions, SearchFilters } from '@shared/types';
import {
  canonicalCorpusKey,
  corpusUnitLabel,
  displayCorpusName,
  inferSourceFormatFromCorpus
} from '../shared/corpusInfo';

export const SCHEMA_VERSION = 3;
const SQLITE_THREADS = Math.max(2, Math.min(8, availableParallelism() - 1));
const SQLITE_CACHE_KIB = -512000;
const SQLITE_MMAP_BYTES = 1024 * 1024 * 1024;

const PERFORMANCE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_documents_corpus_topic ON documents(corpus_id, category, topic, doc_id)',
  'CREATE INDEX IF NOT EXISTS idx_utterances_filters ON utterances(corpus_id, year, category, topic)',
  'CREATE INDEX IF NOT EXISTS idx_utterances_speaker ON utterances(speaker_sex, speaker_age, speaker_occupation)',
  'CREATE INDEX IF NOT EXISTS idx_utterances_doc_sequence ON utterances(corpus_id, doc_id, sequence)',
  'CREATE INDEX IF NOT EXISTS idx_occ_corpus_doc ON token_occurrences(corpus_id, doc_id, source)',
  'CREATE INDEX IF NOT EXISTS idx_occ_term_source ON token_occurrences(source, term_id, utterance_rowid, token_index)',
  'CREATE INDEX IF NOT EXISTS idx_occ_lemma_source ON token_occurrences(source, lemma_term_id, corpus_id)',
  'CREATE INDEX IF NOT EXISTS idx_occ_pos_source ON token_occurrences(source, pos_term_id, corpus_id)',
  'CREATE INDEX IF NOT EXISTS idx_occ_utterance_index ON token_occurrences(utterance_rowid, source, token_index)',
  'CREATE INDEX IF NOT EXISTS idx_occ_window ON token_occurrences(source, utterance_rowid, token_index)',
  'CREATE INDEX IF NOT EXISTS idx_value_stats_kind ON value_stats(kind, value)'
];

const PERFORMANCE_INDEX_NAMES = [
  'idx_documents_corpus_topic',
  'idx_utterances_filters',
  'idx_utterances_speaker',
  'idx_utterances_doc_sequence',
  'idx_occ_corpus_doc',
  'idx_occ_term_source',
  'idx_occ_lemma_source',
  'idx_occ_pos_source',
  'idx_occ_utterance_index',
  'idx_occ_window',
  'idx_value_stats_kind'
];

export interface InsertDocumentInput {
  corpusId: string;
  docId: string;
  title: string;
  author: string;
  publisher: string;
  date: string;
  topic: string;
  category: string;
  year: string;
  metadataJson: string;
}

export interface InsertSpeakerInput {
  corpusId: string;
  docId: string;
  speakerId: string;
  age: string;
  occupation: string;
  sex: string;
  birthplace: string;
  principalResidence: string;
  currentResidence: string;
  education: string;
  device: string;
  keyboard: string;
  metadataJson: string;
}

export interface InsertUtteranceInput {
  corpusId: string;
  docId: string;
  utteranceId: string;
  speakerId: string;
  sequence: number;
  form: string;
  originalForm: string;
  tokensJson: string;
  normalizedTokensJson: string;
  time: string | null;
  start: number | null;
  end: number | null;
  note: string;
  category: string;
  topic: string;
  year: string;
  speakerAge: string;
  speakerSex: string;
  speakerOccupation: string;
  metadataJson: string;
}

export interface InsertTokenOccurrenceInput {
  utteranceRowId: number;
  corpusId: string;
  docId: string;
  tokenIndex: number;
  termId: number;
  lemmaTermId: number | null;
  posTermId: number | null;
  source: string;
}

export class CorpusDatabase {
  readonly db: Database.Database;
  private bulkIndexesDropped = false;

  private readonly termCache = new Map<string, number>();
  private readonly insertCorpusStmt;
  private readonly updateCorpusStmt;
  private readonly insertDocumentStmt;
  private readonly insertSpeakerStmt;
  private readonly insertUtteranceStmt;
  private readonly insertOccurrenceStmt;
  private readonly insertTermStmt;
  private readonly selectTermStmt;
  private readonly insertTokenStatStmt;
  private readonly insertValueStatStmt;
  private readonly rebuildDocumentStatsStmt;
  private readonly rebuildExploreCategoryStatsStmt;
  private readonly rebuildExploreTopicStatsStmt;
  private readonly rebuildFtsStmt;

  constructor(private readonly databasePath: string) {
    resetOutdatedDatabase(databasePath);
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma(`cache_size = ${SQLITE_CACHE_KIB}`);
    this.db.pragma(`mmap_size = ${SQLITE_MMAP_BYTES}`);
    this.db.pragma(`threads = ${SQLITE_THREADS}`);
    this.migrate();

    this.insertCorpusStmt = this.db.prepare(`
      INSERT INTO corpora (
        id, name, source_path, source_type, status, imported_at,
        file_count, document_count, utterance_count, token_count, error
      ) VALUES (
        @id, @name, @sourcePath, @sourceType, @status, @importedAt,
        @fileCount, @documentCount, @utteranceCount, @tokenCount, @error
      )
    `);

    this.updateCorpusStmt = this.db.prepare(`
      UPDATE corpora
      SET status = @status,
          file_count = @fileCount,
          document_count = @documentCount,
          utterance_count = @utteranceCount,
          token_count = @tokenCount,
          error = @error,
          imported_at = @importedAt
      WHERE id = @id
    `);

    this.insertDocumentStmt = this.db.prepare(`
      INSERT OR IGNORE INTO documents (
        corpus_id, doc_id, title, author, publisher, date,
        topic, category, year, metadata_json
      ) VALUES (
        @corpusId, @docId, @title, @author, @publisher, @date,
        @topic, @category, @year, @metadataJson
      )
    `);

    this.insertSpeakerStmt = this.db.prepare(`
      INSERT OR IGNORE INTO speakers (
        corpus_id, doc_id, speaker_id, age, occupation, sex, birthplace,
        principal_residence, current_residence, education, device, keyboard,
        metadata_json
      ) VALUES (
        @corpusId, @docId, @speakerId, @age, @occupation, @sex, @birthplace,
        @principalResidence, @currentResidence, @education, @device, @keyboard,
        @metadataJson
      )
    `);

    this.insertUtteranceStmt = this.db.prepare(`
      INSERT INTO utterances (
        corpus_id, doc_id, utterance_id, speaker_id, sequence, form,
        original_form, tokens_json, normalized_tokens_json, time, start, end,
        note, category, topic, year, speaker_age, speaker_sex,
        speaker_occupation, metadata_json
      ) VALUES (
        @corpusId, @docId, @utteranceId, @speakerId, @sequence, @form,
        @originalForm, @tokensJson, @normalizedTokensJson, @time, @start, @end,
        @note, @category, @topic, @year, @speakerAge, @speakerSex,
        @speakerOccupation, @metadataJson
      )
    `);

    this.insertOccurrenceStmt = this.db.prepare(`
      INSERT INTO token_occurrences (
        utterance_rowid, corpus_id, doc_id, token_index,
        term_id, lemma_term_id, pos_term_id, source
      ) VALUES (
        @utteranceRowId, @corpusId, @docId, @tokenIndex,
        @termId, @lemmaTermId, @posTermId, @source
      )
    `);

    this.insertTermStmt = this.db.prepare('INSERT OR IGNORE INTO terms(value) VALUES (?)');
    this.selectTermStmt = this.db.prepare('SELECT id FROM terms WHERE value = ?');
    this.insertTokenStatStmt = this.db.prepare(`
      INSERT INTO token_stats(corpus_id, term_id, source, count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(corpus_id, term_id, source)
      DO UPDATE SET count = count + excluded.count
    `);
    this.insertValueStatStmt = this.db.prepare(`
      INSERT INTO value_stats(corpus_id, kind, value, count)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(corpus_id, kind, value)
      DO UPDATE SET count = count + excluded.count
    `);
    this.rebuildDocumentStatsStmt = this.db.prepare(`
      INSERT INTO document_stats(corpus_id, doc_id, utterance_count, first_sequence, last_sequence)
      SELECT corpus_id, doc_id, COUNT(*), MIN(sequence), MAX(sequence)
      FROM utterances
      WHERE corpus_id = ?
      GROUP BY corpus_id, doc_id
    `);
    this.rebuildExploreCategoryStatsStmt = this.db.prepare(`
      INSERT INTO explore_category_stats(corpus_id, category, count)
      SELECT corpus_id, category, COUNT(*)
      FROM documents
      WHERE corpus_id = ?
      GROUP BY corpus_id, category
    `);
    this.rebuildExploreTopicStatsStmt = this.db.prepare(`
      INSERT INTO explore_topic_stats(corpus_id, category, topic, count)
      SELECT corpus_id, category, topic, COUNT(*)
      FROM documents
      WHERE corpus_id = ?
      GROUP BY corpus_id, category, topic
    `);
    this.rebuildFtsStmt = this.db.prepare(`
      INSERT INTO utterance_fts(rowid, form, original_form)
      SELECT id, form, original_form
      FROM utterances
      WHERE corpus_id = ?
    `);
  }

  close(): void {
    this.db.close();
  }

  beginBulk(options: { dropPerformanceIndexes?: boolean } = {}): void {
    this.bulkIndexesDropped = Boolean(options.dropPerformanceIndexes);
    this.db.pragma('synchronous = OFF');
    this.db.pragma(`threads = ${SQLITE_THREADS}`);
    this.db.exec('BEGIN IMMEDIATE');
    if (this.bulkIndexesDropped) this.dropPerformanceIndexes();
  }

  commitBulk(): void {
    if (this.bulkIndexesDropped) this.createPerformanceIndexes();
    this.db.exec('COMMIT');
    this.bulkIndexesDropped = false;
    this.db.pragma('synchronous = NORMAL');
  }

  rollbackBulk(): void {
    if (this.db.inTransaction) this.db.exec('ROLLBACK');
    if (this.bulkIndexesDropped) this.createPerformanceIndexes();
    this.bulkIndexesDropped = false;
    this.db.pragma('synchronous = NORMAL');
  }

  optimizeStorage(): void {
    this.createPerformanceIndexes();
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.pragma('optimize');
  }

  rebuildDerivedData(corpusId: string): void {
    this.db.prepare('DELETE FROM utterance_fts WHERE rowid IN (SELECT id FROM utterances WHERE corpus_id = ?)').run(corpusId);
    this.db.prepare('DELETE FROM document_stats WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM explore_category_stats WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM explore_topic_stats WHERE corpus_id = ?').run(corpusId);
    this.rebuildFtsStmt.run(corpusId);
    this.rebuildDocumentStatsStmt.run(corpusId);
    this.rebuildExploreCategoryStatsStmt.run(corpusId);
    this.rebuildExploreTopicStatsStmt.run(corpusId);
  }

  createCorpus(input: {
    id: string;
    name: string;
    sourcePath: string;
    sourceType: string;
    status?: CorpusStatus;
    error?: string | null;
  }): CorpusRecord {
    const record = {
      id: input.id,
      name: input.name,
      sourcePath: input.sourcePath,
      sourceType: input.sourceType,
      status: input.status ?? ('running' as CorpusStatus),
      importedAt: new Date().toISOString(),
      fileCount: 0,
      documentCount: 0,
      utteranceCount: 0,
      tokenCount: 0,
      error: input.error ?? null
    };
    this.insertCorpusStmt.run(record);
    return record;
  }

  createSkippedCorpus(input: {
    id: string;
    name: string;
    sourcePath: string;
    sourceType: string;
    reason: string;
  }): CorpusRecord {
    return this.createCorpus({
      ...input,
      status: 'skipped_duplicate',
      error: input.reason
    });
  }

  updateCorpus(record: CorpusRecord): CorpusRecord {
    const next = {
      ...record,
      importedAt: new Date().toISOString()
    };
    this.updateCorpusStmt.run(next);
    return next;
  }

  listCorpora(): CorpusRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, source_path AS sourcePath, source_type AS sourceType,
                status, imported_at AS importedAt, file_count AS fileCount,
                document_count AS documentCount, utterance_count AS utteranceCount,
                token_count AS tokenCount, error
         FROM corpora
         ORDER BY imported_at DESC`
      )
      .all() as CorpusRecord[];
    return rows.map((row) => hydrateCorpusRecord(row));
  }

  getCorpus(corpusId: string): CorpusRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, source_path AS sourcePath, source_type AS sourceType,
                status, imported_at AS importedAt, file_count AS fileCount,
                document_count AS documentCount, utterance_count AS utteranceCount,
                token_count AS tokenCount, error
         FROM corpora
         WHERE id = ?`
      )
      .get(corpusId) as CorpusRecord | undefined;
    return row ? hydrateCorpusRecord(row) : undefined;
  }

  findReadyCorpusForSource(sourcePath: string, name: string): CorpusRecord | undefined {
    const sourceKey = canonicalCorpusKey({ name, sourcePath });
    const normalizedSourcePath = sourcePath.replace(/\\/gu, '/').toLowerCase();
    return this.listCorpora().find((corpus) => {
      if (!isUsableReadyCorpus(corpus)) return false;
      if (corpus.sourcePath.replace(/\\/gu, '/').toLowerCase() === normalizedSourcePath) return true;
      return canonicalCorpusKey(corpus) === sourceKey;
    });
  }

  hasReadyMessengerJsonCorpus(): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM corpora
         WHERE status = 'ready'
           AND utterance_count > 0
           AND (name LIKE '%MESSENGER_v2.0_JSON%' OR source_path LIKE '%MESSENGER_v2.0_JSON%')
         LIMIT 1`
      )
      .get() as { 1: number } | undefined;
    return Boolean(row);
  }

  hasReadyCorpusData(excludeCorpusId?: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM corpora
         WHERE status = 'ready'
           AND id <> ?
           AND (document_count > 0 OR utterance_count > 0 OR token_count > 0)
         LIMIT 1`
      )
      .get(excludeCorpusId ?? '') as { 1: number } | undefined;
    return Boolean(row);
  }

  deleteCorpus(corpusId: string): void {
    const tx = this.db.transaction(() => {
      this.clearCorpusData(corpusId);
      this.db.prepare('DELETE FROM corpora WHERE id = ?').run(corpusId);
    });
    tx();
  }

  clearCorpusData(corpusId: string): void {
    this.db.prepare('DELETE FROM utterance_fts WHERE rowid IN (SELECT id FROM utterances WHERE corpus_id = ?)').run(corpusId);
    this.db.prepare('DELETE FROM document_stats WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM explore_category_stats WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM explore_topic_stats WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM token_occurrences WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM token_stats WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM value_stats WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM utterances WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM speakers WHERE corpus_id = ?').run(corpusId);
    this.db.prepare('DELETE FROM documents WHERE corpus_id = ?').run(corpusId);
  }

  insertDocument(input: InsertDocumentInput): void {
    this.insertDocumentStmt.run(input);
  }

  insertSpeaker(input: InsertSpeakerInput): void {
    this.insertSpeakerStmt.run(input);
  }

  insertUtterance(input: InsertUtteranceInput): number {
    const info = this.insertUtteranceStmt.run(input);
    return Number(info.lastInsertRowid);
  }

  insertOccurrence(input: InsertTokenOccurrenceInput): void {
    this.insertOccurrenceStmt.run(input);
  }

  getTermId(value: string | null | undefined): number | null {
    if (!value) return null;
    const cached = this.termCache.get(value);
    if (cached !== undefined) return cached;
    this.insertTermStmt.run(value);
    const row = this.selectTermStmt.get(value) as { id: number };
    this.termCache.set(value, row.id);
    return row.id;
  }

  getExistingTermId(value: string | null | undefined): number | null {
    if (!value) return null;
    const cached = this.termCache.get(value);
    if (cached !== undefined) return cached;
    const row = this.selectTermStmt.get(value) as { id: number } | undefined;
    if (!row) return null;
    this.termCache.set(value, row.id);
    return row.id;
  }

  insertTokenStat(corpusId: string, termId: number, source: string, count: number): void {
    this.insertTokenStatStmt.run(corpusId, termId, source, count);
  }

  insertValueStat(corpusId: string, kind: string, value: string, count: number): void {
    this.insertValueStatStmt.run(corpusId, kind, value, count);
  }

  getFilterOptions(): FilterOptions {
    const distinct = (column: string): string[] =>
      (this.db.prepare(`SELECT DISTINCT ${column} AS value FROM documents WHERE ${column} <> '' ORDER BY value`).all() as Array<{ value: string }>)
        .map((row) => row.value);
    const speakerDistinct = (column: string): string[] =>
      (this.db.prepare(`SELECT DISTINCT ${column} AS value FROM speakers WHERE ${column} <> '' ORDER BY value`).all() as Array<{ value: string }>)
        .map((row) => row.value);

    return {
      years: distinct('year'),
      categories: distinct('category'),
      topics: distinct('topic'),
      speakerSexes: speakerDistinct('sex'),
      speakerAges: speakerDistinct('age'),
      speakerOccupations: speakerDistinct('occupation'),
      corpora: this.listCorpora()
        .filter((corpus) => corpus.status === 'ready')
        .map((corpus) => ({ id: corpus.id, name: corpus.name }))
    };
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA user_version = ${SCHEMA_VERSION};

      CREATE TABLE IF NOT EXISTS corpora (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_type TEXT NOT NULL,
        status TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        document_count INTEGER NOT NULL DEFAULT 0,
        utterance_count INTEGER NOT NULL DEFAULT 0,
        token_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS documents (
        corpus_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        publisher TEXT NOT NULL,
        date TEXT NOT NULL,
        topic TEXT NOT NULL,
        category TEXT NOT NULL,
        year TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY (corpus_id, doc_id),
        FOREIGN KEY (corpus_id) REFERENCES corpora(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS speakers (
        corpus_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        speaker_id TEXT NOT NULL,
        age TEXT NOT NULL,
        occupation TEXT NOT NULL,
        sex TEXT NOT NULL,
        birthplace TEXT NOT NULL,
        principal_residence TEXT NOT NULL,
        current_residence TEXT NOT NULL,
        education TEXT NOT NULL,
        device TEXT NOT NULL,
        keyboard TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY (corpus_id, doc_id, speaker_id),
        FOREIGN KEY (corpus_id, doc_id) REFERENCES documents(corpus_id, doc_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS utterances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        corpus_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        utterance_id TEXT NOT NULL,
        speaker_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        form TEXT NOT NULL,
        original_form TEXT NOT NULL,
        tokens_json TEXT NOT NULL,
        normalized_tokens_json TEXT NOT NULL,
        time TEXT,
        start REAL,
        end REAL,
        note TEXT NOT NULL,
        category TEXT NOT NULL,
        topic TEXT NOT NULL,
        year TEXT NOT NULL,
        speaker_age TEXT NOT NULL,
        speaker_sex TEXT NOT NULL,
        speaker_occupation TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        UNIQUE (corpus_id, utterance_id),
        FOREIGN KEY (corpus_id, doc_id) REFERENCES documents(corpus_id, doc_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        value TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS token_occurrences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        utterance_rowid INTEGER NOT NULL,
        corpus_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        token_index INTEGER NOT NULL,
        term_id INTEGER NOT NULL,
        lemma_term_id INTEGER,
        pos_term_id INTEGER,
        source TEXT NOT NULL,
        FOREIGN KEY (utterance_rowid) REFERENCES utterances(id) ON DELETE CASCADE,
        FOREIGN KEY (term_id) REFERENCES terms(id),
        FOREIGN KEY (lemma_term_id) REFERENCES terms(id),
        FOREIGN KEY (pos_term_id) REFERENCES terms(id)
      );

      CREATE TABLE IF NOT EXISTS token_stats (
        corpus_id TEXT NOT NULL,
        term_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (corpus_id, term_id, source)
      );

      CREATE TABLE IF NOT EXISTS document_stats (
        corpus_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        utterance_count INTEGER NOT NULL,
        first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        PRIMARY KEY (corpus_id, doc_id),
        FOREIGN KEY (corpus_id, doc_id) REFERENCES documents(corpus_id, doc_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS explore_category_stats (
        corpus_id TEXT NOT NULL,
        category TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (corpus_id, category)
      );

      CREATE TABLE IF NOT EXISTS explore_topic_stats (
        corpus_id TEXT NOT NULL,
        category TEXT NOT NULL,
        topic TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (corpus_id, category, topic)
      );

      CREATE TABLE IF NOT EXISTS value_stats (
        corpus_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (corpus_id, kind, value)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS utterance_fts
      USING fts5(form, original_form, tokenize = 'trigram');

    `);
    this.createPerformanceIndexes();
  }

  private createPerformanceIndexes(): void {
    for (const sql of PERFORMANCE_INDEXES) this.db.exec(sql);
  }

  private dropPerformanceIndexes(): void {
    for (const name of PERFORMANCE_INDEX_NAMES) this.db.exec(`DROP INDEX IF EXISTS ${name}`);
  }
}

export interface SqlFilterResult {
  clause: string;
  params: unknown[];
}

export function buildUtteranceFilterClause(filters: SearchFilters, alias = 'u'): SqlFilterResult {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const addIn = (column: string, values?: string[]): void => {
    const clean = (values ?? []).filter(Boolean);
    if (clean.length === 0) return;
    clauses.push(`${alias}.${column} IN (${clean.map(() => '?').join(', ')})`);
    params.push(...clean);
  };

  addIn('corpus_id', filters.corpusIds);
  addIn('year', filters.years);
  addIn('category', filters.categories);
  addIn('topic', filters.topics);
  addIn('speaker_sex', filters.speakerSexes);
  addIn('speaker_age', filters.speakerAges);
  addIn('speaker_occupation', filters.speakerOccupations);

  return {
    clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params
  };
}

function resetOutdatedDatabase(databasePath: string): void {
  if (!existsSync(databasePath)) return;

  let userVersion = 0;
  try {
    const probe = new Database(databasePath, { readonly: true, fileMustExist: true });
    userVersion = Number((probe.pragma('user_version', { simple: true }) as number | undefined) ?? 0);
    probe.close();
  } catch {
    userVersion = 0;
  }

  if (userVersion === SCHEMA_VERSION) return;

  const versionLabel = userVersion > 0 ? String(userVersion) : 'unknown';
  const timestamp = new Date().toISOString().replace(/\D/gu, '');
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${databasePath}${suffix}`;
    if (!existsSync(target)) continue;
    const backupPath = `${databasePath}.schema-v${versionLabel}.backup-${timestamp}${suffix}`;
    renameSync(target, backupPath);
  }
}

function hydrateCorpusRecord(record: CorpusRecord): CorpusRecord {
  const sourceFormat = inferSourceFormatFromCorpus(record);
  return {
    ...record,
    name: displayCorpusName(record),
    sourceFormat,
    unitLabel: corpusUnitLabel(sourceFormat)
  };
}

function isUsableReadyCorpus(corpus: CorpusRecord): boolean {
  return corpus.status === 'ready' && corpus.utteranceCount > 0;
}
