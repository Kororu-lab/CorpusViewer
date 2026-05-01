import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import JSON5 from 'json5';
import yauzl from 'yauzl';
import type { CorpusRecord, ImportProgress } from '@shared/types';
import type {
  CorpusDatabase,
  InsertDocumentInput,
  InsertSpeakerInput,
  InsertUtteranceInput
} from './database';
import { normalizeToken, tokenizeText } from './tokenizer';

interface ImportCounters {
  fileCount: number;
  documentCount: number;
  utteranceCount: number;
  tokenCount: number;
}

interface ImportOptions {
  corpusId?: string;
  name?: string;
}

interface NlikSpeaker {
  id?: unknown;
  age?: unknown;
  occupation?: unknown;
  sex?: unknown;
  birthplace?: unknown;
  principal_residence?: unknown;
  pricipal_residence?: unknown;
  current_residence?: unknown;
  education?: unknown;
  device?: unknown;
  keyboard?: unknown;
  [key: string]: unknown;
}

interface ProvidedToken {
  surface: string;
  normalized: string;
  lemma: string | null;
  pos: string | null;
  morphJson: string | null;
}

class ImportStats {
  readonly tokenCounts = new Map<string, number>();
  readonly valueCounts = new Map<string, number>();

  addToken(source: string, termId: number): void {
    increment(this.tokenCounts, `${source}\t${termId}`);
  }

  addValue(kind: string, value: string): void {
    if (!value) return;
    increment(this.valueCounts, `${kind}\t${value}`);
  }
}

const JSON_ENTRY = /\.json$/iu;
const CSV_ENTRY = /\.csv$/iu;
const ZIP_ENTRY = /\.zip$/iu;

export class ImportCancelledError extends Error {
  constructor() {
    super('가져오기가 취소되었습니다.');
  }
}

export class CorpusImporter {
  constructor(
    private readonly database: CorpusDatabase,
    private readonly onProgress: (progress: ImportProgress) => void,
    private readonly shouldCancel: () => boolean = () => false
  ) {}

  async importDefault(defaultCorporaDir: string): Promise<CorpusRecord[]> {
    const children = readdirSync(defaultCorporaDir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => path.join(defaultCorporaDir, entry.name));

    const imported: CorpusRecord[] = [];
    for (const child of selectImportSources(children)) {
      imported.push(await this.importPath(child));
    }
    return imported;
  }

  async importPath(sourcePath: string, options: ImportOptions = {}): Promise<CorpusRecord> {
    const stats = statSync(sourcePath);
    const sourceType = stats.isDirectory() ? 'directory' : path.extname(sourcePath).slice(1).toLowerCase();
    const name = options.name ?? makeCorpusName(sourcePath);
    const corpusId = options.corpusId ?? makeCorpusId(name, sourcePath);

    if (!options.corpusId && isMessengerCsvSource(sourcePath) && this.database.hasReadyMessengerJsonCorpus()) {
      const skipped = this.database.createSkippedCorpus({
        id: corpusId,
        name,
        sourcePath,
        sourceType,
        reason: '동일한 메신저 JSON 말뭉치가 있어 CSV 가져오기를 건너뛰었습니다.'
      });
      this.emit(corpusId, name, 'skipped_duplicate', zeroCounters(), skipped.error ?? undefined);
      return skipped;
    }

    let record =
      options.corpusId && this.database.getCorpus(options.corpusId)
        ? this.database.getCorpus(options.corpusId)!
        : this.database.createCorpus({ id: corpusId, name, sourcePath, sourceType });

    if (options.corpusId) {
      this.database.clearCorpusData(corpusId);
      record = this.database.updateCorpus({
        ...record,
        status: 'running',
        fileCount: 0,
        documentCount: 0,
        utteranceCount: 0,
        tokenCount: 0,
        error: null
      });
    }

    const counters = zeroCounters();
    const statsCollector = new ImportStats();

    this.emit(corpusId, name, 'started', counters, '가져오기를 시작했습니다.');
    this.database.beginBulk();

    try {
      this.throwIfCancelled();
      if (stats.isDirectory()) {
        await this.importDirectory(sourcePath, corpusId, counters, statsCollector);
      } else if (ZIP_ENTRY.test(sourcePath)) {
        await this.importZip(sourcePath, corpusId, counters, statsCollector);
      } else if (JSON_ENTRY.test(sourcePath)) {
        const json = await readFileText(sourcePath);
        await this.importJsonDocument(JSON.parse(json), corpusId, counters, statsCollector);
      } else if (CSV_ENTRY.test(sourcePath)) {
        await this.importCsvStream(createReadStream(sourcePath), corpusId, counters, statsCollector);
        counters.fileCount += 1;
      } else {
        throw new Error(`지원하지 않는 파일 형식입니다: ${sourcePath}`);
      }

      this.emit(corpusId, name, 'finalizing', counters, '통계와 검색 인덱스를 생성하는 중입니다.');
      this.flushStats(corpusId, statsCollector);
      this.database.rebuildDerivedData(corpusId);
      this.database.commitBulk();
      this.emit(corpusId, name, 'finalizing', counters, '저장 공간을 최적화하는 중입니다.');
      this.database.optimizeStorage();
      const done = this.database.updateCorpus({
        ...record,
        status: 'ready',
        fileCount: counters.fileCount,
        documentCount: counters.documentCount,
        utteranceCount: counters.utteranceCount,
        tokenCount: counters.tokenCount,
        error: null
      });
      this.emit(corpusId, name, 'done', counters, '가져오기가 완료되었습니다.');
      return done;
    } catch (error) {
      this.database.rollbackBulk();
      const cancelled = error instanceof ImportCancelledError;
      const failed = this.database.updateCorpus({
        ...record,
        status: cancelled ? 'cancelled' : 'failed',
        fileCount: counters.fileCount,
        documentCount: counters.documentCount,
        utteranceCount: counters.utteranceCount,
        tokenCount: counters.tokenCount,
        error: error instanceof Error ? error.message : String(error)
      });
      this.emit(corpusId, name, cancelled ? 'cancelled' : 'failed', counters, failed.error ?? undefined);
      throw error;
    }
  }

  private async importDirectory(
    sourcePath: string,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats
  ): Promise<void> {
    for (const file of listImportableFiles(sourcePath)) {
      this.throwIfCancelled();
      if (JSON_ENTRY.test(file)) {
        const json = await readFileText(file);
        await this.importJsonDocument(JSON.parse(json), corpusId, counters, stats);
      } else if (CSV_ENTRY.test(file)) {
        await this.importCsvStream(createReadStream(file), corpusId, counters, stats);
        counters.fileCount += 1;
      }
      if (counters.fileCount % 100 === 0) this.emit(corpusId, path.basename(sourcePath), 'reading', counters);
    }
  }

  private async importZip(
    zipPath: string,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats
  ): Promise<void> {
    const zip = await openZip(zipPath);
    const label = path.basename(zipPath);

    await new Promise<void>((resolve, reject) => {
      zip.readEntry();

      zip.on('entry', async (entry) => {
        const name = zipEntryName(entry);
        const isDirectory = /\/$/u.test(name);
        if (isDirectory || (!JSON_ENTRY.test(name) && !CSV_ENTRY.test(name))) {
          zip.readEntry();
          return;
        }

        try {
          this.throwIfCancelled();
          const stream = await openZipReadStream(zip, entry);
          if (JSON_ENTRY.test(name)) {
            const json = await streamToString(stream);
            await this.importJsonDocument(JSON.parse(json), corpusId, counters, stats);
          } else if (CSV_ENTRY.test(name)) {
            await this.importCsvStream(stream, corpusId, counters, stats);
            counters.fileCount += 1;
          }
          if (counters.fileCount % 100 === 0 || CSV_ENTRY.test(name)) {
            this.emit(corpusId, label, 'reading', counters, name);
          }
          zip.readEntry();
        } catch (error) {
          reject(error);
        }
      });

      zip.once('end', () => resolve());
      zip.once('error', reject);
    });

    zip.close();
  }

  private async importJsonDocument(root: any, corpusId: string, counters: ImportCounters, stats: ImportStats): Promise<void> {
    const fileMetadata = root?.metadata ?? {};
    const category = text(fileMetadata.category);
    const year = text(fileMetadata.year);
    const documents = Array.isArray(root?.document) ? root.document : [];
    counters.fileCount += 1;

    for (const doc of documents) {
      this.throwIfCancelled();
      const docMetadata = doc?.metadata ?? {};
      const docId = text(doc?.id);
      const topic = text(docMetadata.topic);
      this.database.insertDocument(toDocumentInput(corpusId, docId, fileMetadata, docMetadata, category, year, topic));
      counters.documentCount += 1;
      stats.addValue('topic', topic);
      stats.addValue('category', category);

      const speakerMap = new Map<string, NlikSpeaker>();
      for (const speaker of asArray<NlikSpeaker>(docMetadata.speaker)) {
        const speakerId = text(speaker.id);
        if (!speakerId) continue;
        speakerMap.set(speakerId, speaker);
        this.database.insertSpeaker(toSpeakerInput(corpusId, docId, speakerId, speaker));
      }

      const utterances = asArray<any>(doc?.utterance);
      for (const [index, utterance] of utterances.entries()) {
        const speakerId = text(utterance.speaker_id);
        const speaker = speakerMap.get(speakerId) ?? {};
        this.insertUtteranceWithTokens({
          corpusId,
          docId,
          utterance,
          speaker,
          speakerId,
          sequence: index + 1,
          category,
          topic,
          year,
          counters,
          stats
        });
        if (counters.utteranceCount % 5000 === 0) {
          this.emit(corpusId, docId || 'JSON', 'indexing', counters);
          await yieldToWorker();
          this.throwIfCancelled();
        }
      }
    }
  }

  private async importCsvStream(
    stream: Readable,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats
  ): Promise<void> {
    const parser = stream.pipe(
      parse({
        bom: true,
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true
      })
    );
    const seenDocuments = new Set<string>();
    const seenSpeakers = new Set<string>();
    const sequenceByDocument = new Map<string, number>();

    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      this.throwIfCancelled();
      const docId = text(row.doc_id);
      const speaker = parseLooseObject(row.speaker) as NlikSpeaker;
      const setting = parseLooseObject(row.setting);
      const speakerId = text(speaker.id);
      const category = '메신저 대화';
      const topic = text(row.topic);
      const year = text(row.date).slice(0, 4);

      if (!seenDocuments.has(docId)) {
        seenDocuments.add(docId);
        this.database.insertDocument({
          corpusId,
          docId,
          title: text(row.title),
          author: text(row.author),
          publisher: text(row.publisher),
          date: text(row.date),
          topic,
          category,
          year,
          metadataJson: JSON.stringify({ setting })
        });
        counters.documentCount += 1;
        stats.addValue('topic', topic);
        stats.addValue('category', category);
      }

      const speakerKey = `${docId}:${speakerId}`;
      if (speakerId && !seenSpeakers.has(speakerKey)) {
        seenSpeakers.add(speakerKey);
        this.database.insertSpeaker(toSpeakerInput(corpusId, docId, speakerId, speaker));
      }

      const sequence = (sequenceByDocument.get(docId) ?? 0) + 1;
      sequenceByDocument.set(docId, sequence);
      this.insertUtteranceWithTokens({
        corpusId,
        docId,
        utterance: {
          id: row.sent_id,
          form: row.form,
          original_form: row.original_form,
          speaker_id: speakerId,
          time: row.time
        },
        speaker,
        speakerId,
        sequence,
        category,
        topic,
        year,
        counters,
        stats
      });

      if (counters.utteranceCount % 5000 === 0) this.emit(corpusId, 'CSV', 'indexing', counters);
    }
  }

  private insertUtteranceWithTokens(input: {
    corpusId: string;
    docId: string;
    utterance: Record<string, unknown>;
    speaker: NlikSpeaker;
    speakerId: string;
    sequence: number;
    category: string;
    topic: string;
    year: string;
    counters: ImportCounters;
    stats: ImportStats;
  }): void {
    const form = text(input.utterance.form);
    const originalForm = text(input.utterance.original_form);
    const rawTokens = tokenizeText(form || originalForm);
    const surfaces = rawTokens.map((token) => token.surface);
    const normalized = rawTokens.map((token) => token.normalized);
    const rowId = this.database.insertUtterance(
      toUtteranceInput({
        ...input,
        form,
        originalForm,
        tokensJson: JSON.stringify(surfaces),
        normalizedTokensJson: JSON.stringify(normalized)
      })
    );

    input.counters.utteranceCount += 1;
    input.stats.addValue('speaker', `${text(input.speaker.sex) || '미상'} / ${text(input.speaker.age) || '미상'}`);

    rawTokens.forEach((token, index) => {
      const termId = this.database.getTermId(token.normalized);
      if (!termId) return;
      this.database.insertOccurrence({
        utteranceRowId: rowId,
        corpusId: input.corpusId,
        docId: input.docId,
        tokenIndex: index,
        termId,
        lemmaTermId: null,
        posTermId: null,
        source: 'raw'
      });
      input.stats.addToken('raw', termId);
      if (isMarker(token.normalized)) input.stats.addValue('marker', token.normalized);
      input.counters.tokenCount += 1;
    });

    detectProvidedTokens(input.utterance).forEach((token, index) => {
      const termId = this.database.getTermId(token.normalized);
      if (!termId) return;
      this.database.insertOccurrence({
        utteranceRowId: rowId,
        corpusId: input.corpusId,
        docId: input.docId,
        tokenIndex: index,
        termId,
        lemmaTermId: this.database.getTermId(token.lemma),
        posTermId: this.database.getTermId(token.pos),
        source: 'provided'
      });
      input.stats.addToken('provided', termId);
      input.counters.tokenCount += 1;
    });
  }

  private flushStats(corpusId: string, stats: ImportStats): void {
    for (const [key, count] of stats.tokenCounts) {
      const [source, termId] = key.split('\t');
      this.database.insertTokenStat(corpusId, Number(termId), source, count);
    }
    for (const [key, count] of stats.valueCounts) {
      const [kind, value] = key.split('\t');
      this.database.insertValueStat(corpusId, kind, value, count);
    }
  }

  private throwIfCancelled(): void {
    if (this.shouldCancel()) throw new ImportCancelledError();
  }

  private emit(
    corpusId: string,
    label: string,
    phase: ImportProgress['phase'],
    counters: ImportCounters,
    message?: string
  ): void {
    this.onProgress({
      corpusId,
      label,
      phase,
      filesDone: counters.fileCount,
      utterancesDone: counters.utteranceCount,
      message
    });
  }
}

export function selectImportSources(paths: string[]): string[] {
  const hasMessengerJson = paths.some(isMessengerJsonSource);
  return hasMessengerJson ? paths.filter((source) => !isMessengerCsvSource(source)) : paths;
}

function toDocumentInput(
  corpusId: string,
  docId: string,
  fileMetadata: Record<string, unknown>,
  docMetadata: Record<string, unknown>,
  category: string,
  year: string,
  topic: string
): InsertDocumentInput {
  return {
    corpusId,
    docId,
    title: text(docMetadata.title),
    author: text(docMetadata.author),
    publisher: text(docMetadata.publisher),
    date: text(docMetadata.date),
    topic,
    category,
    year,
    metadataJson: JSON.stringify({ file: fileMetadata, document: docMetadata })
  };
}

function toUtteranceInput(input: {
  corpusId: string;
  docId: string;
  utterance: Record<string, unknown>;
  speaker: NlikSpeaker;
  speakerId: string;
  sequence: number;
  form: string;
  originalForm: string;
  tokensJson: string;
  normalizedTokensJson: string;
  category: string;
  topic: string;
  year: string;
}): InsertUtteranceInput {
  return {
    corpusId: input.corpusId,
    docId: input.docId,
    utteranceId: text(input.utterance.id),
    speakerId: input.speakerId,
    sequence: input.sequence,
    form: input.form,
    originalForm: input.originalForm,
    tokensJson: input.tokensJson,
    normalizedTokensJson: input.normalizedTokensJson,
    time: text(input.utterance.time) || null,
    start: numberOrNull(input.utterance.start),
    end: numberOrNull(input.utterance.end),
    note: text(input.utterance.note),
    category: input.category,
    topic: input.topic,
    year: input.year,
    speakerAge: text(input.speaker.age),
    speakerSex: text(input.speaker.sex),
    speakerOccupation: text(input.speaker.occupation),
    metadataJson: JSON.stringify(input.utterance)
  };
}

function toSpeakerInput(
  corpusId: string,
  docId: string,
  speakerId: string,
  speaker: NlikSpeaker
): InsertSpeakerInput {
  return {
    corpusId,
    docId,
    speakerId,
    age: text(speaker.age),
    occupation: text(speaker.occupation),
    sex: text(speaker.sex),
    birthplace: text(speaker.birthplace),
    principalResidence: text(speaker.principal_residence ?? speaker.pricipal_residence),
    currentResidence: text(speaker.current_residence),
    education: text(speaker.education),
    device: text(speaker.device),
    keyboard: text(speaker.keyboard),
    metadataJson: JSON.stringify(speaker)
  };
}

export function detectProvidedTokens(utterance: Record<string, unknown>): ProvidedToken[] {
  const keys = ['tokens', 'token', 'morph', 'morphs', 'word', 'words'];
  for (const key of keys) {
    const value = utterance[key];
    if (!Array.isArray(value)) continue;
    const tokens = value.map(normalizeProvidedToken).filter((token): token is ProvidedToken => Boolean(token));
    if (tokens.length > 0) return tokens;
  }
  return [];
}

function normalizeProvidedToken(value: unknown): ProvidedToken | null {
  if (typeof value === 'string') {
    const normalized = normalizeToken(value);
    return normalized ? { surface: value, normalized, lemma: null, pos: null, morphJson: null } : null;
  }
  if (!value || typeof value !== 'object') return null;

  const row = value as Record<string, unknown>;
  const surface = text(row.surface ?? row.form ?? row.text ?? row.word ?? row.token ?? row.orth);
  const normalized = normalizeToken(surface);
  if (!surface || !normalized) return null;

  return {
    surface,
    normalized,
    lemma: optionalText(row.lemma ?? row.lexeme ?? row.base),
    pos: optionalText(row.pos ?? row.tag ?? row.upos ?? row.xpos),
    morphJson: JSON.stringify(row)
  };
}

function parseLooseObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON5.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function optionalText(value: unknown): string | null {
  const result = text(value);
  return result || null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function makeCorpusName(sourcePath: string): string {
  return path.basename(sourcePath).replace(/\.[^.]+$/u, '');
}

function makeCorpusId(name: string, sourcePath: string): string {
  const hash = createHash('sha1').update(`${sourcePath}:${Date.now()}`).digest('hex').slice(0, 8);
  const slug = name
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 48);
  return `${slug || 'corpus'}-${hash}`;
}

function listImportableFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listImportableFiles(full));
    } else if (JSON_ENTRY.test(entry.name) || CSV_ENTRY.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function readFileText(filePath: string): Promise<string> {
  return streamToString(createReadStream(filePath));
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: false }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('ZIP 파일을 열 수 없습니다.'));
      else resolve(zip);
    });
  });
}

function zipEntryName(entry: yauzl.Entry): string {
  const fileName = entry.fileName as unknown;
  if (Buffer.isBuffer(fileName)) return fileName.toString('utf8');
  return String(fileName);
}

function openZipReadStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error('ZIP 항목을 읽을 수 없습니다.'));
      else resolve(stream);
    });
  });
}

function streamToString(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/u, '')));
  });
}

function zeroCounters(): ImportCounters {
  return { fileCount: 0, documentCount: 0, utteranceCount: 0, tokenCount: 0 };
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function yieldToWorker(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isMarker(value: string): boolean {
  return value.startsWith('{') && value.endsWith('}');
}

function isMessengerJsonSource(sourcePath: string): boolean {
  return /MESSENGER.*JSON/iu.test(sourcePath) || /NIKL_MESSENGER_v2\.0_JSON/iu.test(sourcePath);
}

function isMessengerCsvSource(sourcePath: string): boolean {
  return /MESSENGER.*CSV/iu.test(sourcePath) || /NIKL_MESSENGER_CSV/iu.test(sourcePath);
}
