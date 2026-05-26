import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TextDecoder } from 'node:util';
import { parse } from 'csv-parse';
import JSON5 from 'json5';
import yauzl from 'yauzl';
import type { CorpusRecord, ImportProgress } from '@shared/types';
import { displayCorpusName, sourceFileStem } from '../shared/corpusInfo';
import { normalizeLegacyHangulText } from '../shared/textNormalization';
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
const TSV_ENTRY = /\.tsv$/iu;
const XML_ENTRY = /\.xml$/iu;
const TXT_ENTRY = /\.txt$/iu;
const ZIP_ENTRY = /\.zip$/iu;
const HISTORICAL_CATEGORY = '역사 말뭉치';
const SEJONG_CATEGORY = '21세기 세종계획';
const PARAGRAPH_CATEGORY = '문단 말뭉치';
const SENTENCE_CATEGORY = '문장 말뭉치';
const PARAPHRASE_CATEGORY = '유사 문장 말뭉치';
const COLA_CATEGORY = '문법성 판단 말뭉치';
const FRAME_XML_CATEGORY = '의미역 기술 모형';
const PSEUDO_TEXT_SPEAKER_ID = 'text';

export type SourceFormat =
  | 'nikl-dialogue'
  | 'nikl-ci-nested-dialogue'
  | 'nikl-ci-sentence-json'
  | 'nikl-iu-web'
  | 'nikl-paragraph-json'
  | 'nikl-sentence-json'
  | 'nikl-paraphrase-json'
  | 'nikl-tabular'
  | 'nikl-cola-tsv'
  | 'nikl-frame-xml'
  | 'nikl-historical-xml'
  | 'sejong-tei-text';

interface HistoricalXmlSent {
  attrs: Record<string, string>;
  text: string;
}

interface HistoricalXmlDocument {
  docId: string;
  title: string;
  author: string;
  publisher: string;
  date: string;
  topic: string;
  category: string;
  year: string;
  metadata: Record<string, unknown>;
  sents: HistoricalXmlSent[];
}

interface HistoricalLetterRecord {
  attrs: Record<string, string>;
  sents: HistoricalXmlSent[];
}

interface HistoricalXmlParts {
  letters: HistoricalLetterRecord[];
  looseSents: HistoricalXmlSent[];
}

interface SejongTeiRow {
  id: string;
  tag: string;
  text: string;
  note: string;
  source: Record<string, string>;
  providedTokens: ProvidedToken[];
}

interface SejongTeiDocument {
  docId: string;
  title: string;
  author: string;
  date: string;
  topic: string;
  category: string;
  year: string;
  metadata: Record<string, unknown>;
  rows: SejongTeiRow[];
}

type TabularSourceFormat = 'dialogue' | 'sentence' | 'annotation' | 'paraphrase' | 'cola';

interface TabularDocumentInput {
  docId: string;
  title: string;
  author: string;
  publisher: string;
  date: string;
  topic: string;
  category: string;
  year: string;
  sourceFormat: SourceFormat;
  extraMetadata?: Record<string, unknown>;
}

interface TabularSentenceAccumulator {
  key: string;
  row: Record<string, string>;
  providedTokens: ProvidedToken[];
}

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
    const name = options.name ?? displayCorpusName(makeCorpusName(sourcePath));
    const corpusId = options.corpusId ?? makeCorpusId(name, sourcePath);

    if (!options.corpusId) {
      const existing = this.database.findReadyCorpusForSource(sourcePath, name);
      if (existing) {
        this.emit(existing.id, existing.name, 'skipped_duplicate', zeroCounters(), '이미 색인된 말뭉치라 가져오기를 건너뛰었습니다.');
        return existing;
      }
    }

    if (!options.corpusId && isMessengerCsvSource(sourcePath) && this.database.hasReadyMessengerJsonCorpus()) {
      this.emit(corpusId, name, 'skipped_duplicate', zeroCounters(), '동일한 메신저 JSON 말뭉치가 있어 CSV 가져오기를 건너뛰었습니다.');
      return {
        id: corpusId,
        name,
        sourcePath,
        sourceType,
        status: 'skipped_duplicate',
        importedAt: new Date().toISOString(),
        fileCount: 0,
        documentCount: 0,
        utteranceCount: 0,
        tokenCount: 0,
        error: '동일한 메신저 JSON 말뭉치가 있어 CSV 가져오기를 건너뛰었습니다.'
      };
    }

    const existingRecord = this.database.getCorpus(corpusId);
    let record = existingRecord ?? this.database.createCorpus({ id: corpusId, name, sourcePath, sourceType });

    if (existingRecord) {
      this.database.clearCorpusData(corpusId);
      record = this.database.updateCorpus({
        ...record,
        name,
        sourcePath,
        sourceType,
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
    const dropPerformanceIndexes = !this.database.hasReadyCorpusData(corpusId);

    this.emit(corpusId, name, 'started', counters, '가져오기를 시작했습니다.');
    // On populated DBs, preserving global indexes avoids a full token index rebuild for a small follow-up import.
    this.database.beginBulk({ dropPerformanceIndexes });

    try {
      this.throwIfCancelled();
      if (stats.isDirectory()) {
        await this.importDirectory(sourcePath, corpusId, counters, statsCollector);
      } else if (ZIP_ENTRY.test(sourcePath)) {
        await this.importZip(sourcePath, corpusId, counters, statsCollector);
      } else if (JSON_ENTRY.test(sourcePath)) {
        const json = await readFileText(sourcePath);
        await this.importJsonDocument(JSON.parse(json), corpusId, counters, statsCollector, sourcePath);
      } else if (CSV_ENTRY.test(sourcePath)) {
        await this.importCsvStream(createReadStream(sourcePath), corpusId, counters, statsCollector, sourcePath);
        counters.fileCount += 1;
      } else if (TSV_ENTRY.test(sourcePath)) {
        await this.importCsvStream(createReadStream(sourcePath), corpusId, counters, statsCollector, sourcePath, '\t');
        counters.fileCount += 1;
      } else if (XML_ENTRY.test(sourcePath)) {
        const xml = await readFileText(sourcePath);
        await this.importXmlDocument(xml, corpusId, counters, statsCollector, sourcePath);
      } else if (TXT_ENTRY.test(sourcePath)) {
        const text = decodeCorpusText(await readFileBuffer(sourcePath));
        await this.importSejongTeiTextDocument(text, corpusId, counters, statsCollector, sourcePath);
      } else {
        throw new Error(`지원하지 않는 파일 형식입니다: ${sourcePath}`);
      }

      validateImportCounters(counters, sourcePath);
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
        await this.importJsonDocument(JSON.parse(json), corpusId, counters, stats, file);
      } else if (CSV_ENTRY.test(file)) {
        await this.importCsvStream(createReadStream(file), corpusId, counters, stats, file);
        counters.fileCount += 1;
      } else if (TSV_ENTRY.test(file)) {
        await this.importCsvStream(createReadStream(file), corpusId, counters, stats, file, '\t');
        counters.fileCount += 1;
      } else if (XML_ENTRY.test(file)) {
        const xml = await readFileText(file);
        await this.importXmlDocument(xml, corpusId, counters, stats, file);
      } else if (TXT_ENTRY.test(file)) {
        const text = decodeCorpusText(await readFileBuffer(file));
        if (isSejongTeiText(text)) {
          await this.importSejongTeiTextDocument(text, corpusId, counters, stats, file);
        }
      } else if (ZIP_ENTRY.test(file) && shouldImportNestedZip(file)) {
        await this.importZip(file, corpusId, counters, stats);
      }
      if (counters.fileCount % 100 === 0) this.emit(corpusId, path.basename(sourcePath), 'reading', counters);
    }
  }

  private async importZip(
    zipPath: string,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    labelOverride?: string
  ): Promise<void> {
    const zip = await openZip(zipPath);
    const closed = waitForZipClose(zip);
    const label = labelOverride ?? path.basename(zipPath);

    try {
      await new Promise<void>((resolve, reject) => {
        zip.readEntry();

        zip.on('entry', async (entry) => {
          const name = zipEntryName(entry);
          const isDirectory = /\/$/u.test(name);
          if (
            isDirectory ||
            (!JSON_ENTRY.test(name) &&
              !CSV_ENTRY.test(name) &&
              !TSV_ENTRY.test(name) &&
              !XML_ENTRY.test(name) &&
              !TXT_ENTRY.test(name) &&
              !ZIP_ENTRY.test(name))
          ) {
            zip.readEntry();
            return;
          }

          try {
            this.throwIfCancelled();
            const stream = await openZipReadStream(zip, entry);
            if (ZIP_ENTRY.test(name)) {
              if (shouldImportNestedZip(name)) {
                await this.importNestedZipStream(stream, corpusId, counters, stats, `${label}::${name}`);
              } else {
                stream.resume();
              }
            } else if (JSON_ENTRY.test(name)) {
              const json = await streamToString(stream);
              await this.importJsonDocument(JSON.parse(json), corpusId, counters, stats, name);
            } else if (CSV_ENTRY.test(name)) {
              await this.importCsvStream(stream, corpusId, counters, stats, name);
              counters.fileCount += 1;
            } else if (TSV_ENTRY.test(name)) {
              await this.importCsvStream(stream, corpusId, counters, stats, name, '\t');
              counters.fileCount += 1;
            } else if (XML_ENTRY.test(name)) {
              const xml = await streamToString(stream);
              await this.importXmlDocument(xml, corpusId, counters, stats, name);
            } else if (TXT_ENTRY.test(name)) {
              const text = decodeCorpusText(await streamToBuffer(stream));
              if (isSejongTeiText(text)) {
                await this.importSejongTeiTextDocument(text, corpusId, counters, stats, name);
              }
            }
            if (counters.fileCount % 100 === 0 || CSV_ENTRY.test(name) || TSV_ENTRY.test(name) || XML_ENTRY.test(name) || TXT_ENTRY.test(name)) {
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
    } finally {
      if (zip.isOpen) zip.close();
      await closed;
    }
  }

  private async importNestedZipStream(
    stream: Readable,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    label: string
  ): Promise<void> {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'corpusviewer-nested-zip-'));
    const tempZipPath = path.join(tempRoot, 'nested.zip');
    try {
      await pipeline(stream, createWriteStream(tempZipPath));
      await this.importZip(tempZipPath, corpusId, counters, stats, label);
    } finally {
      removeTempDirectoryBestEffort(tempRoot);
    }
  }

  private async importZipBuffer(
    buffer: Buffer,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    label: string
  ): Promise<void> {
    const zip = await openZipBuffer(buffer);

    await new Promise<void>((resolve, reject) => {
      zip.readEntry();

      zip.on('entry', async (entry) => {
        const name = zipEntryName(entry);
        const isDirectory = /\/$/u.test(name);
        if (isDirectory || (!JSON_ENTRY.test(name) && !CSV_ENTRY.test(name) && !TSV_ENTRY.test(name) && !XML_ENTRY.test(name) && !TXT_ENTRY.test(name))) {
          zip.readEntry();
          return;
        }

        try {
          this.throwIfCancelled();
          const stream = await openZipReadStream(zip, entry);
          if (JSON_ENTRY.test(name)) {
            const json = await streamToString(stream);
            await this.importJsonDocument(JSON.parse(json), corpusId, counters, stats, `${label}::${name}`);
          } else if (CSV_ENTRY.test(name)) {
            await this.importCsvStream(stream, corpusId, counters, stats, `${label}::${name}`);
            counters.fileCount += 1;
          } else if (TSV_ENTRY.test(name)) {
            await this.importCsvStream(stream, corpusId, counters, stats, `${label}::${name}`, '\t');
            counters.fileCount += 1;
          } else if (XML_ENTRY.test(name)) {
            const xml = await streamToString(stream);
            await this.importXmlDocument(xml, corpusId, counters, stats, `${label}::${name}`);
          } else if (TXT_ENTRY.test(name)) {
            const text = decodeCorpusText(await streamToBuffer(stream));
            if (isSejongTeiText(text)) {
              await this.importSejongTeiTextDocument(text, corpusId, counters, stats, `${label}::${name}`);
            }
          }
          if (counters.fileCount % 100 === 0 || TSV_ENTRY.test(name) || TXT_ENTRY.test(name)) this.emit(corpusId, label, 'reading', counters, name);
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

  private async importJsonDocument(
    root: any,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    sourceFile = 'JSON'
  ): Promise<void> {
    const sourceFormat = detectJsonSourceFormat(root);
    try {
      if (sourceFormat === 'nikl-ci-nested-dialogue') {
        await this.importCiNestedDialogueJson(root, corpusId, counters, stats, sourceFile);
      } else if (sourceFormat === 'nikl-iu-web') {
        await this.importIuWebJson(root, corpusId, counters, stats, sourceFile);
      } else if (sourceFormat === 'nikl-paragraph-json') {
        await this.importParagraphJsonDocument(root, corpusId, counters, stats, sourceFile);
      } else if (sourceFormat === 'nikl-sentence-json' || sourceFormat === 'nikl-ci-sentence-json') {
        await this.importSentenceJsonDocument(root, corpusId, counters, stats, sourceFile, sourceFormat);
      } else if (sourceFormat === 'nikl-paraphrase-json') {
        await this.importParaphraseJsonDocument(root, corpusId, counters, stats, sourceFile);
      } else {
        await this.importStandardJsonDocument(root, corpusId, counters, stats, sourceFile);
      }
    } catch (error) {
      throw new Error(`${sourceFile} (${sourceFormat}) 가져오기 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async importStandardJsonDocument(
    root: any,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    sourceFile: string
  ): Promise<void> {
    const fileMetadata = root?.metadata ?? {};
    const category = text(fileMetadata.category);
    const year = text(fileMetadata.year);
    const documents = asArray<any>(root?.document);
    counters.fileCount += 1;

    for (const doc of documents) {
      this.throwIfCancelled();
      const docMetadata = doc?.metadata ?? {};
      const docId = text(doc?.id);
      const topic = text(docMetadata.topic);
      this.database.insertDocument(
        toDocumentInput(corpusId, docId, fileMetadata, docMetadata, category, year, topic, {
          sourceFormat: 'nikl-dialogue',
          sourceFile
        })
      );
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
          utterance: { ...utterance, sourceFormat: 'nikl-dialogue', sourceFile },
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

  private async importCiNestedDialogueJson(
    root: any,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    sourceFile: string
  ): Promise<void> {
    const fileMetadata = root?.metadata ?? {};
    const outerDocuments = asArray<any>(root?.document);
    counters.fileCount += 1;

    for (const [outerIndex, outerDoc] of outerDocuments.entries()) {
      this.throwIfCancelled();
      const outerMetadata = outerDoc?.metadata ?? {};
      const innerDocuments = asArray<any>(outerDoc?.document);

      for (const [innerIndex, innerDoc] of innerDocuments.entries()) {
        const docMetadata = innerDoc?.metadata ?? {};
        const docId = text(innerDoc?.id) || `${text(outerDoc?.id) || `outer-${outerIndex + 1}`}.${innerIndex + 1}`;
        const category = text(docMetadata.category) || text(outerMetadata.category) || text(fileMetadata.category);
        const year = text(docMetadata.year) || text(outerMetadata.year) || text(fileMetadata.year);
        const topic = text(docMetadata.topic) || text(outerMetadata.topic) || text(outerMetadata.category) || category;

        this.database.insertDocument(
          toDocumentInput(corpusId, docId, fileMetadata, docMetadata, category, year, topic, {
            sourceFormat: 'nikl-ci-nested-dialogue',
            sourceFile,
            outerDocument: { id: text(outerDoc?.id), metadata: outerMetadata },
            setting: docMetadata.setting ?? null,
            inference: innerDoc?.inference ?? null
          })
        );
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

        for (const [index, utterance] of asArray<any>(innerDoc?.utterance).entries()) {
          const speakerId = text(utterance.speaker_id);
          const speaker = speakerMap.get(speakerId) ?? {};
          this.insertUtteranceWithTokens({
            corpusId,
            docId,
            utterance: { ...utterance, sourceFormat: 'nikl-ci-nested-dialogue', sourceFile },
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
            this.emit(corpusId, docId, 'indexing', counters);
            await yieldToWorker();
            this.throwIfCancelled();
          }
        }
      }
    }
  }

  private async importIuWebJson(
    root: any,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    sourceFile: string
  ): Promise<void> {
    const fileMetadata = root?.metadata ?? {};
    const documents = asArray<any>(root?.document);
    counters.fileCount += 1;

    for (const [docIndex, doc] of documents.entries()) {
      this.throwIfCancelled();
      const docMetadata = doc?.metadata ?? {};
      const docId = text(doc?.id) || `iu-doc-${docIndex + 1}`;
      const category = text(fileMetadata.category) || '웹 말뭉치';
      const topic = text(docMetadata.topic) || text(docMetadata.category) || text(fileMetadata.category) || '웹 문서';
      const year = text(docMetadata.year) || text(docMetadata.date).slice(0, 4) || text(fileMetadata.year);
      const immoralBySentenceId = new Map<string, unknown[]>();

      for (const expression of asArray<Record<string, unknown>>(doc?.immoral_expression)) {
        const expressionId = text(expression.expression_id);
        if (!expressionId) continue;
        const list = immoralBySentenceId.get(expressionId) ?? [];
        list.push(expression);
        immoralBySentenceId.set(expressionId, list);
      }

      this.database.insertDocument(
        toDocumentInput(corpusId, docId, fileMetadata, docMetadata, category, year, topic, {
          sourceFormat: 'nikl-iu-web',
          sourceFile,
          paragraph: doc?.paragraph ?? [],
          immoralExpression: doc?.immoral_expression ?? []
        })
      );
      counters.documentCount += 1;
      stats.addValue('topic', topic);
      stats.addValue('category', category);
      this.database.insertSpeaker(
        toSpeakerInput(corpusId, docId, PSEUDO_TEXT_SPEAKER_ID, {
          id: PSEUDO_TEXT_SPEAKER_ID,
          occupation: '텍스트',
          sourceFormat: 'nikl-iu-web',
          pseudo: true
        })
      );

      for (const [index, sentence] of asArray<Record<string, unknown>>(doc?.sentence).entries()) {
        const sentenceId = text(sentence.id) || `${docId}.sentence.${index + 1}`;
        this.insertUtteranceWithTokens({
          corpusId,
          docId,
          utterance: {
            ...sentence,
            id: sentenceId,
            speaker_id: PSEUDO_TEXT_SPEAKER_ID,
            sourceFormat: 'nikl-iu-web',
            sourceFile,
            immoralExpression: immoralBySentenceId.get(sentenceId) ?? []
          },
          speaker: { id: PSEUDO_TEXT_SPEAKER_ID, occupation: '텍스트' },
          speakerId: PSEUDO_TEXT_SPEAKER_ID,
          sequence: index + 1,
          category,
          topic,
          year,
          counters,
          stats
        });
        if (counters.utteranceCount % 5000 === 0) {
          this.emit(corpusId, docId, 'indexing', counters);
          await yieldToWorker();
          this.throwIfCancelled();
        }
      }
    }
  }

  private async importParagraphJsonDocument(
    root: any,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    sourceFile: string
  ): Promise<void> {
    const fileMetadata = root?.metadata ?? {};
    const documents = asArray<any>(root?.document);
    counters.fileCount += 1;

    for (const [docIndex, doc] of documents.entries()) {
      this.throwIfCancelled();
      const docMetadata = doc?.metadata ?? {};
      const docId = text(doc?.id) || `${sourceFileStem(sourceFile)}.doc.${docIndex + 1}`;
      const category = text(fileMetadata.category) || text(docMetadata.category) || PARAGRAPH_CATEGORY;
      const topic = text(docMetadata.topic) || text(docMetadata.original_topic) || text(docMetadata.title) || category;
      const year = text(docMetadata.year) || text(docMetadata.date).slice(0, 4) || text(fileMetadata.year);

      this.database.insertDocument(
        toDocumentInput(corpusId, docId, fileMetadata, docMetadata, category, year, topic, {
          sourceFormat: 'nikl-paragraph-json',
          sourceFile
        })
      );
      counters.documentCount += 1;
      stats.addValue('topic', topic);
      stats.addValue('category', category);
      this.database.insertSpeaker(toSpeakerInput(corpusId, docId, PSEUDO_TEXT_SPEAKER_ID, pseudoTextSpeaker('nikl-paragraph-json')));

      for (const [index, paragraph] of asArray<Record<string, unknown>>(doc?.paragraph).entries()) {
        const rawForm = text(paragraph.form);
        const rawOriginal = text(paragraph.original_form) || rawForm;
        const form = cleanCorpusInlineText(rawForm);
        const originalForm = cleanCorpusInlineText(rawOriginal);
        if (!form && !originalForm) continue;
        this.insertUtteranceWithTokens({
          corpusId,
          docId,
          utterance: {
            ...paragraph,
            id: text(paragraph.id) || `${docId}.paragraph.${index + 1}`,
            form,
            original_form: originalForm,
            speaker_id: PSEUDO_TEXT_SPEAKER_ID,
            sourceFormat: 'nikl-paragraph-json',
            sourceFile
          },
          speaker: pseudoTextSpeaker('nikl-paragraph-json'),
          speakerId: PSEUDO_TEXT_SPEAKER_ID,
          sequence: index + 1,
          category,
          topic,
          year,
          counters,
          stats
        });
        if (counters.utteranceCount % 5000 === 0) {
          this.emit(corpusId, docId, 'indexing', counters);
          await yieldToWorker();
          this.throwIfCancelled();
        }
      }
    }
  }

  private async importSentenceJsonDocument(
    root: any,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    sourceFile: string,
    sourceFormat: SourceFormat = 'nikl-sentence-json'
  ): Promise<void> {
    const fileMetadata = root?.metadata ?? {};
    const documents = asArray<any>(root?.document);
    const idNamespace = sentenceJsonIdNamespace(root, sourceFile, sourceFormat);
    counters.fileCount += 1;

    for (const [docIndex, doc] of documents.entries()) {
      this.throwIfCancelled();
      const docMetadata = doc?.metadata ?? {};
      const originalDocId = text(doc?.id) || `${sourceFileStem(sourceFile)}.doc.${docIndex + 1}`;
      const docId = idNamespace ? `${idNamespace}:${originalDocId}` : originalDocId;
      const baseCategory = text(fileMetadata.category) || text(docMetadata.category) || SENTENCE_CATEGORY;
      const annotationLevel = text(fileMetadata.annotation_level);
      const category =
        sourceFormat === 'nikl-ci-sentence-json' && annotationLevel ? `${baseCategory} > ${annotationLevel}` : baseCategory;
      const topic = text(docMetadata.topic) || text(docMetadata.original_topic) || text(docMetadata.title) || category;
      const year = text(docMetadata.year) || text(docMetadata.date).slice(0, 4) || text(fileMetadata.year);

      this.database.insertDocument(
        toDocumentInput(corpusId, docId, fileMetadata, docMetadata, category, year, topic, {
          sourceFormat,
          sourceFile,
          sourceRootId: text(root?.id) || null,
          originalDocId: idNamespace ? originalDocId : null,
          annotationLevel: annotationLevel || null,
          contextInference: compactContextInferenceMetadata(doc?.CI)
        })
      );
      counters.documentCount += 1;
      stats.addValue('topic', topic);
      stats.addValue('category', category);

      const speakerMap = new Map<string, NlikSpeaker>();
      for (const speaker of asArray<NlikSpeaker>(docMetadata.speaker)) {
        const speakerId = speakerIdFromNiklSpeaker(speaker);
        if (!speakerId) continue;
        speakerMap.set(speakerId, speaker);
        this.database.insertSpeaker(toSpeakerInput(corpusId, docId, speakerId, speaker));
      }
      if (speakerMap.size === 0) {
        this.database.insertSpeaker(toSpeakerInput(corpusId, docId, PSEUDO_TEXT_SPEAKER_ID, pseudoTextSpeaker(sourceFormat)));
      }

      for (const [index, sentence] of asArray<Record<string, unknown>>(doc?.sentence).entries()) {
        const originalSentenceId = text(sentence.id) || `${originalDocId}.sentence.${index + 1}`;
        const sentenceId = idNamespace ? `${idNamespace}:${originalSentenceId}` : originalSentenceId;
        const speakerId = speakerIdFromValue(sentence.speaker_id ?? sentence.dis_speaker_id) || PSEUDO_TEXT_SPEAKER_ID;
        const speaker = speakerMap.get(speakerId) ?? pseudoTextSpeaker(sourceFormat);
        this.insertUtteranceWithTokens({
          corpusId,
          docId,
          utterance: {
            ...sentence,
            id: sentenceId,
            form: cleanCorpusInlineText(text(sentence.form)),
            original_form: cleanCorpusInlineText(text(sentence.original_form) || text(sentence.form)),
            speaker_id: speakerId,
            sourceFormat,
            sourceFile,
            sourceRootId: text(root?.id) || null,
            originalDocId: idNamespace ? originalDocId : null,
            originalSentenceId: idNamespace ? originalSentenceId : null
          },
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
          this.emit(corpusId, docId, 'indexing', counters);
          await yieldToWorker();
          this.throwIfCancelled();
        }
      }
    }
  }

  private async importParaphraseJsonDocument(
    root: any,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    sourceFile: string
  ): Promise<void> {
    const fileMetadata = root?.metadata ?? {};
    const data = asArray<Record<string, unknown>>(root?.data);
    const seenDocuments = new Set<string>();
    const sequenceByDocument = new Map<string, number>();
    counters.fileCount += 1;

    for (const item of data) {
      this.throwIfCancelled();
      const sentenceId = text(item.sentence_id) || `${sourceFileStem(sourceFile)}.sentence`;
      const docId = inferDocumentIdFromSentenceId(sentenceId);
      if (!seenDocuments.has(docId)) {
        seenDocuments.add(docId);
        this.database.insertDocument({
          corpusId,
          docId,
          title: sentenceId,
          author: '',
          publisher: '국립국어원',
          date: '',
          topic: text(fileMetadata.title) || PARAPHRASE_CATEGORY,
          category: PARAPHRASE_CATEGORY,
          year: text(fileMetadata.year),
          metadataJson: JSON.stringify({
            sourceFormat: 'nikl-paraphrase-json',
            sourceFile,
            sourceSentenceId: sentenceId,
            file: fileMetadata
          })
        });
        counters.documentCount += 1;
        stats.addValue('topic', text(fileMetadata.title) || PARAPHRASE_CATEGORY);
        stats.addValue('category', PARAPHRASE_CATEGORY);
        this.database.insertSpeaker(toSpeakerInput(corpusId, docId, PSEUDO_TEXT_SPEAKER_ID, pseudoTextSpeaker('nikl-paraphrase-json')));
      }

      for (const [index, paraphrase] of asArray<Record<string, unknown>>(item.paraphrases).entries()) {
        const form = cleanCorpusInlineText(text(paraphrase.form));
        if (!form) continue;
        const sequence = (sequenceByDocument.get(docId) ?? 0) + 1;
        sequenceByDocument.set(docId, sequence);
        this.insertUtteranceWithTokens({
          corpusId,
          docId,
          utterance: {
            ...paraphrase,
            id: `${sentenceId}.paraphrase.${index + 1}`,
            form,
            original_form: form,
            speaker_id: PSEUDO_TEXT_SPEAKER_ID,
            sourceFormat: 'nikl-paraphrase-json',
            sourceFile,
            sourceSentenceId: sentenceId
          },
          speaker: pseudoTextSpeaker('nikl-paraphrase-json'),
          speakerId: PSEUDO_TEXT_SPEAKER_ID,
          sequence,
          category: PARAPHRASE_CATEGORY,
          topic: text(fileMetadata.title) || PARAPHRASE_CATEGORY,
          year: text(fileMetadata.year),
          counters,
          stats
        });
        if (counters.utteranceCount % 5000 === 0) {
          this.emit(corpusId, docId, 'indexing', counters);
          await yieldToWorker();
          this.throwIfCancelled();
        }
      }
    }
  }

  private async importXmlDocument(
    xml: string,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    sourceFile: string
  ): Promise<void> {
    if (isFrameXmlDocument(xml)) {
      await this.importFrameXmlDocument(xml, corpusId, counters, stats, sourceFile);
      return;
    }
    await this.importHistoricalXmlDocument(xml, corpusId, counters, stats, sourceFile);
  }

  private async importHistoricalXmlDocument(
    xml: string,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    sourceFile: string
  ): Promise<void> {
    const documents = extractHistoricalXmlDocuments(xml, sourceFile);
    counters.fileCount += 1;

    for (const doc of documents) {
      this.throwIfCancelled();
      this.database.insertDocument({
        corpusId,
        docId: doc.docId,
        title: doc.title,
        author: doc.author,
        publisher: doc.publisher,
        date: doc.date,
        topic: doc.topic,
        category: doc.category,
        year: doc.year,
        metadataJson: JSON.stringify({
          sourceFormat: 'nikl-historical-xml',
          sourceFile,
          xml: doc.metadata
        })
      });
      counters.documentCount += 1;
      stats.addValue('topic', doc.topic);
      stats.addValue('category', doc.category);
      this.database.insertSpeaker(
        toSpeakerInput(corpusId, doc.docId, PSEUDO_TEXT_SPEAKER_ID, {
          id: PSEUDO_TEXT_SPEAKER_ID,
          occupation: '텍스트',
          sourceFormat: 'nikl-historical-xml',
          pseudo: true
        })
      );

      for (const [index, sent] of doc.sents.entries()) {
        this.insertUtteranceWithTokens({
          corpusId,
          docId: doc.docId,
          utterance: {
            id: `${doc.docId}.sent.${index + 1}`,
            form: sent.text,
            original_form: sent.text,
            speaker_id: PSEUDO_TEXT_SPEAKER_ID,
            note: historicalSentNote(sent.attrs),
            sourceFormat: 'nikl-historical-xml',
            sourceFile,
            xml: { sent: sent.attrs }
          },
          speaker: { id: PSEUDO_TEXT_SPEAKER_ID, occupation: '텍스트' },
          speakerId: PSEUDO_TEXT_SPEAKER_ID,
          sequence: index + 1,
          category: doc.category,
          topic: doc.topic,
          year: doc.year,
          counters,
          stats
        });
        if (counters.utteranceCount % 5000 === 0) {
          this.emit(corpusId, doc.docId, 'indexing', counters);
          await yieldToWorker();
          this.throwIfCancelled();
        }
      }
    }
  }

  private async importFrameXmlDocument(
    xml: string,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    sourceFile: string
  ): Promise<void> {
    const fileBase = sourceFileStem(sourceFile);
    const lemma = extractTagText(xml, 'lemma') || fileBase;
    const kdef = extractTagText(xml, 'kdef');
    const edef = extractTagText(xml, 'edef');
    const examples = extractFrameExamples(xml);
    const rows = examples.length > 0 ? examples : [kdef || edef || lemma].filter(Boolean);
    if (rows.length === 0) {
      counters.fileCount += 1;
      return;
    }

    const docId = `${safeIdentifier(fileBase, 1)}-${shortHash(sourceFile)}`;
    this.database.insertDocument({
      corpusId,
      docId,
      title: lemma,
      author: '',
      publisher: '국립국어원',
      date: '',
      topic: lemma,
      category: FRAME_XML_CATEGORY,
      year: '',
      metadataJson: JSON.stringify({
        sourceFormat: 'nikl-frame-xml',
        sourceFile,
        frame: {
          lemma,
          kdef,
          edef,
          frameIds: extractTagTexts(xml, 'id').slice(0, 20)
        }
      })
    });
    counters.fileCount += 1;
    counters.documentCount += 1;
    stats.addValue('topic', lemma);
    stats.addValue('category', FRAME_XML_CATEGORY);
    this.database.insertSpeaker(
      toSpeakerInput(corpusId, docId, PSEUDO_TEXT_SPEAKER_ID, {
        id: PSEUDO_TEXT_SPEAKER_ID,
        occupation: '텍스트',
        sourceFormat: 'nikl-frame-xml',
        pseudo: true
      })
    );

    for (const [index, row] of rows.entries()) {
      this.insertUtteranceWithTokens({
        corpusId,
        docId,
        utterance: {
          id: `${docId}.example.${index + 1}`,
          form: row,
          original_form: row,
          speaker_id: PSEUDO_TEXT_SPEAKER_ID,
          sourceFormat: 'nikl-frame-xml',
          sourceFile,
          note: lemma
        },
        speaker: { id: PSEUDO_TEXT_SPEAKER_ID, occupation: '텍스트' },
        speakerId: PSEUDO_TEXT_SPEAKER_ID,
        sequence: index + 1,
        category: FRAME_XML_CATEGORY,
        topic: lemma,
        year: '',
        counters,
        stats
      });
    }
  }

  private async importSejongTeiTextDocument(
    content: string,
    corpusId: string,
    counters: ImportCounters,
    stats: ImportStats,
    sourceFile: string
  ): Promise<void> {
    if (!isSejongTeiText(content)) {
      throw new Error(`${sourceFile} (sejong-tei-text) 가져오기 실패: 21세기 세종계획 TEI 텍스트가 아닙니다.`);
    }
    const documents = extractSejongTeiDocuments(content, sourceFile);
    counters.fileCount += 1;

    for (const doc of documents) {
      this.throwIfCancelled();
      this.database.insertDocument({
        corpusId,
        docId: doc.docId,
        title: doc.title,
        author: doc.author,
        publisher: '국립국어연구원',
        date: doc.date,
        topic: doc.topic,
        category: doc.category,
        year: doc.year,
        metadataJson: JSON.stringify({
          sourceFormat: 'sejong-tei-text',
          sourceFile,
          sejong: doc.metadata
        })
      });
      counters.documentCount += 1;
      stats.addValue('topic', doc.topic);
      stats.addValue('category', doc.category);
      this.database.insertSpeaker(
        toSpeakerInput(corpusId, doc.docId, PSEUDO_TEXT_SPEAKER_ID, {
          id: PSEUDO_TEXT_SPEAKER_ID,
          occupation: '텍스트',
          sourceFormat: 'sejong-tei-text',
          pseudo: true
        })
      );

      for (const [index, row] of doc.rows.entries()) {
        this.insertUtteranceWithTokens({
          corpusId,
          docId: doc.docId,
          utterance: {
            id: row.id || `${doc.docId}.row.${index + 1}`,
            form: row.text,
            original_form: row.text,
            speaker_id: PSEUDO_TEXT_SPEAKER_ID,
            note: row.note,
            sourceFormat: 'sejong-tei-text',
            sejong: {
              tag: row.tag,
              source: row.source
            }
          },
          providedTokens: row.providedTokens,
          speaker: { id: PSEUDO_TEXT_SPEAKER_ID, occupation: '텍스트' },
          speakerId: PSEUDO_TEXT_SPEAKER_ID,
          sequence: index + 1,
          category: doc.category,
          topic: doc.topic,
          year: doc.year,
          counters,
          stats
        });
        if (counters.utteranceCount % 5000 === 0) {
          this.emit(corpusId, doc.docId, 'indexing', counters);
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
    stats: ImportStats,
    sourceFile = 'CSV',
    delimiter = ','
  ): Promise<void> {
    const parser = stream.pipe(
      parse({
        bom: true,
        columns: true,
        delimiter,
        skip_empty_lines: true,
        relax_column_count: true
      })
    );
    const seenDocuments = new Set<string>();
    const seenSpeakers = new Set<string>();
    const sequenceByDocument = new Map<string, number>();
    let format: TabularSourceFormat | null = null;
    let pendingSentence: TabularSentenceAccumulator | null = null;
    const importer = this;

    const ensureDocument = (input: TabularDocumentInput): void => {
      if (seenDocuments.has(input.docId)) return;
      seenDocuments.add(input.docId);
      this.database.insertDocument({
        corpusId,
        docId: input.docId,
        title: input.title,
        author: input.author,
        publisher: input.publisher,
        date: input.date,
        topic: input.topic,
        category: input.category,
        year: input.year,
        metadataJson: JSON.stringify({
          sourceFormat: input.sourceFormat,
          sourceFile,
          ...(input.extraMetadata ?? {})
        })
      });
      counters.documentCount += 1;
      stats.addValue('topic', input.topic);
      stats.addValue('category', input.category);
    };

    const ensureSpeaker = (docId: string, speakerId: string, speaker: NlikSpeaker): void => {
      if (!speakerId) return;
      const speakerKey = `${docId}:${speakerId}`;
      if (seenSpeakers.has(speakerKey)) return;
      seenSpeakers.add(speakerKey);
      this.database.insertSpeaker(toSpeakerInput(corpusId, docId, speakerId, speaker));
    };

    const insertTabularSentence = (row: Record<string, string>, providedTokens: ProvidedToken[] = []): void => {
      const doc = tabularDocumentInput(row, sourceFile, format ?? 'sentence');
      ensureDocument(doc);
      const parsedSpeaker = parseLooseObject(row.speaker) as NlikSpeaker;
      const speakerId = text(row.speaker_id) || text(parsedSpeaker.id) || PSEUDO_TEXT_SPEAKER_ID;
      const speaker =
        speakerId === PSEUDO_TEXT_SPEAKER_ID
          ? pseudoTextSpeaker(doc.sourceFormat)
          : Object.keys(parsedSpeaker).length > 0
            ? parsedSpeaker
            : ({ id: speakerId } as NlikSpeaker);
      ensureSpeaker(doc.docId, speakerId, speaker);
      const sequence = (sequenceByDocument.get(doc.docId) ?? 0) + 1;
      sequenceByDocument.set(doc.docId, sequence);
      const sentenceId = text(row.sentence_id ?? row.sent_id ?? row.id) || `${doc.docId}.sentence.${sequence}`;
      const form = cleanCorpusInlineText(text(row.sentence ?? row.sentence_form ?? row.form));
      const originalForm = cleanCorpusInlineText(text(row.sentence_original_form ?? row.original_form) || form);
      if (!form && !originalForm) return;
      this.insertUtteranceWithTokens({
        corpusId,
        docId: doc.docId,
        utterance: {
          id: sentenceId,
          form,
          original_form: originalForm,
          speaker_id: speakerId,
          time: row.time,
          note: text(row.note) || tabularRowNote(row, format ?? 'sentence'),
          sourceFormat: doc.sourceFormat,
          sourceFile,
          row
        },
        providedTokens,
        speaker,
        speakerId,
        sequence,
        category: doc.category,
        topic: doc.topic,
        year: doc.year,
        counters,
        stats
      });
    };

    const flushPendingSentence = (): void => {
      if (!pendingSentence) return;
      insertTabularSentence(pendingSentence.row, pendingSentence.providedTokens);
      pendingSentence = null;
    };

    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      this.throwIfCancelled();
      format ??= detectTabularSourceFormat(row, sourceFile, delimiter);

      if (format === 'annotation') {
        const key = text(row.sentence_id ?? row.sent_id ?? row.id) || `${text(row.doc_id ?? row.document_id)}:${text(row.form)}`;
        if (!pendingSentence || pendingSentence.key !== key) {
          flushPendingSentence();
          pendingSentence = { key, row: { ...row }, providedTokens: [] };
        }
        const token = tabularProvidedToken(row);
        if (token) pendingSentence.providedTokens.push(token);
      } else if (format === 'paraphrase') {
        flushPendingSentence();
        insertParaphraseCsvRow(row);
      } else {
        flushPendingSentence();
        insertTabularSentence(row);
      }

      if (counters.utteranceCount > 0 && counters.utteranceCount % 5000 === 0) this.emit(corpusId, 'CSV', 'indexing', counters);
    }

    flushPendingSentence();

    function insertParaphraseCsvRow(row: Record<string, string>): void {
      const sentenceId = text(row.sentence_id) || `${sourceFileStem(sourceFile)}.sentence`;
      const docId = inferDocumentIdFromSentenceId(sentenceId);
      const topic = PARAPHRASE_CATEGORY;
      ensureDocument({
        docId,
        title: sentenceId,
        author: '',
        publisher: '국립국어원',
        date: '',
        topic,
        category: PARAPHRASE_CATEGORY,
        year: '',
        sourceFormat: 'nikl-tabular',
        extraMetadata: { tabularFormat: 'paraphrase', sourceSentenceId: sentenceId }
      });
      ensureSpeaker(docId, PSEUDO_TEXT_SPEAKER_ID, pseudoTextSpeaker('nikl-tabular'));
      const sequence = (sequenceByDocument.get(docId) ?? 0) + 1;
      sequenceByDocument.set(docId, sequence);
      const form = cleanCorpusInlineText(text(row.form));
      if (!form) return;
      importer.insertUtteranceWithTokens({
        corpusId,
        docId,
        utterance: {
          id: `${sentenceId}.paraphrase.${text(row['']) || sequence}`,
          form,
          original_form: form,
          speaker_id: PSEUDO_TEXT_SPEAKER_ID,
          note: text(row.generation),
          sourceFormat: 'nikl-tabular',
          sourceFile,
          row
        },
        speaker: pseudoTextSpeaker('nikl-tabular'),
        speakerId: PSEUDO_TEXT_SPEAKER_ID,
        sequence,
        category: PARAPHRASE_CATEGORY,
        topic,
        year: '',
        counters,
        stats
      });
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
    providedTokens?: ProvidedToken[];
  }): void {
    const form = normalizeLegacyHangulText(text(input.utterance.form));
    const originalForm = normalizeLegacyHangulText(text(input.utterance.original_form));
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

    const providedTokens = input.providedTokens ?? detectProvidedTokens(input.utterance);
    providedTokens.forEach((token, index) => {
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
  const newspaperJsonKeys = new Set(paths.filter(isPreferredNewspaperSource).map(newspaperSourceKey).filter(Boolean));
  return paths.filter((source) => {
    if (hasMessengerJson && isMessengerCsvSource(source)) return false;
    if (isNewspaperCsvSource(source) && newspaperJsonKeys.has(newspaperSourceKey(source))) return false;
    return true;
  });
}

export function detectJsonSourceFormat(root: any): SourceFormat {
  if (asArray<Record<string, unknown>>(root?.data).some((item) => Array.isArray(item?.paraphrases))) {
    return 'nikl-paraphrase-json';
  }

  const documents: any[] = asArray<any>(root?.document);
  if (documents.some((doc) => asArray<any>(doc?.document).some((inner) => Array.isArray(inner?.utterance)))) {
    return 'nikl-ci-nested-dialogue';
  }
  if (documents.some((doc) => asArray<any>(doc?.utterance).length > 0)) {
    return 'nikl-dialogue';
  }
  if (documents.some((doc) => asArray<any>(doc?.sentence).length > 0 && asArray<any>(doc?.CI).length > 0)) {
    return 'nikl-ci-sentence-json';
  }
  if (documents.some((doc) => Array.isArray(doc?.immoral_expression))) {
    return 'nikl-iu-web';
  }
  if (documents.some((doc) => asArray<any>(doc?.sentence).length > 0)) return 'nikl-sentence-json';
  if (documents.some((doc) => asArray<any>(doc?.paragraph).length > 0)) return 'nikl-paragraph-json';
  return 'nikl-dialogue';
}

export function extractHistoricalXmlDocuments(xml: string, sourceFile: string): HistoricalXmlDocument[] {
  const fileBase = path.basename(sourceFile).replace(/\.[^.]+$/u, '');
  const header = extractHistoricalHeader(xml, fileBase);
  const parts = extractHistoricalXmlParts(xml);
  const documents: HistoricalXmlDocument[] = [];

  if (parts.letters.length > 0) {
    for (const [index, letter] of parts.letters.entries()) {
      if (letter.sents.length === 0) continue;
      const letterNumber = text(letter.attrs.n) || String(index + 1);
      const docId = `${fileBase}.letter.${index + 1}-${safeIdentifier(letterNumber, index + 1)}`;
      documents.push({
        docId,
        title: header.title,
        author: text(letter.attrs.writer) || text(letter.attrs.sender) || header.author,
        publisher: header.publisher,
        date: text(letter.attrs.year) || header.date,
        topic: header.topic,
        category: HISTORICAL_CATEGORY,
        year: normalizeHistoricalYear(text(letter.attrs.year)) || header.year,
        metadata: {
          header: header.metadata,
          letter: letter.attrs,
          recoveredBy: 'sent-tag-scanner'
        },
        sents: letter.sents
      });
    }
  }

  if (parts.looseSents.length > 0) {
    documents.push({
      docId: fileBase,
      title: header.title,
      author: header.author,
      publisher: header.publisher,
      date: header.date,
      topic: header.topic,
      category: HISTORICAL_CATEGORY,
      year: header.year,
      metadata: {
        header: header.metadata,
        recoveredBy: 'sent-tag-scanner'
      },
      sents: parts.looseSents
    });
  }

  return documents;
}

export function extractSejongTeiDocuments(content: string, sourceFile: string): SejongTeiDocument[] {
  const fileBase = sourceFileStem(sourceFile.replace(/::/gu, '/'));
  const docId = `${safeIdentifier(fileBase, 1)}-${shortHash(sourceFile)}`;
  const title = extractTagText(content, 'title') || fileBase;
  const author = extractTagText(content, 'author');
  const headerDate = extractTagText(content, 'date');
  const idno = extractTagText(content, 'idno');
  const category = inferSejongCategory(sourceFile);
  const rows: SejongTeiRow[] = [];
  let currentSource: Record<string, string> = {};

  const blockPattern = /<(source|head|p)\b[^>]*>([\s\S]*?)<\/\1>/giu;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(content))) {
    const tag = match[1].toLowerCase();
    const body = match[2] ?? '';
    if (tag === 'source') {
      currentSource = extractSejongSourceInfo(body);
      continue;
    }

    const text = sejongBlockText(body);
    if (!text) continue;
    const firstId = firstSejongLineId(body);
    const rowSource = { ...currentSource };
    const rowIndex = rows.length + 1;
    rows.push({
      id: `${docId}.${firstId || `${tag}.${rowIndex}`}.${rowIndex}`,
      tag,
      text,
      note: sejongNote(tag, rowSource),
      source: rowSource,
      providedTokens: parseSejongProvidedTokens(body)
    });
  }

  if (rows.length === 0) {
    const fallback = stripXmlText(content);
    if (fallback) {
      rows.push({
        id: `${docId}.text.1`,
        tag: 'text',
        text: fallback,
        note: '',
        source: {},
        providedTokens: []
      });
    }
  }

  return [
    {
      docId,
      title,
      author,
      date: rows[0]?.source.date || headerDate,
      topic: title || idno || fileBase,
      category,
      year: normalizeHistoricalYear(rows[0]?.source.date || headerDate),
      metadata: {
        title,
        author,
        idno,
        headerDate,
        layer: inferSejongLayer(sourceFile)
      },
      rows
    }
  ];
}

function toDocumentInput(
  corpusId: string,
  docId: string,
  fileMetadata: Record<string, unknown>,
  docMetadata: Record<string, unknown>,
  category: string,
  year: string,
  topic: string,
  extraMetadata: Record<string, unknown> = {}
): InsertDocumentInput {
  return {
    corpusId,
    docId,
    title: normalizeLegacyHangulText(text(docMetadata.title)),
    author: normalizeLegacyHangulText(text(docMetadata.author)),
    publisher: normalizeLegacyHangulText(text(docMetadata.publisher)),
    date: text(docMetadata.date),
    topic: normalizeLegacyHangulText(topic),
    category: normalizeLegacyHangulText(category),
    year,
    metadataJson: JSON.stringify({ ...extraMetadata, file: fileMetadata, document: docMetadata })
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
    metadataJson: JSON.stringify(compactUtteranceMetadata(input.utterance))
  };
}

function compactUtteranceMetadata(utterance: Record<string, unknown>): Record<string, unknown> {
  const metadata = { ...utterance };
  for (const key of ['tokens', 'token', 'morph', 'morphs', 'word', 'words', 'row', 'SRL', 'srl', 'ZA', 'za', 'DP', 'dependency', 'NE', 'ne']) {
    delete metadata[key];
  }
  return metadata;
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

function pseudoTextSpeaker(sourceFormat: SourceFormat): NlikSpeaker {
  return {
    id: PSEUDO_TEXT_SPEAKER_ID,
    occupation: '텍스트',
    sourceFormat,
    pseudo: true
  };
}

function cleanCorpusInlineText(value: string): string {
  const textValue = value.trim();
  if (!textValue) return '';
  const decoded = /<[a-z][\s\S]*>/iu.test(textValue) ? stripXmlText(textValue) : decodeXmlEntities(textValue);
  return normalizeWhitespace(normalizeLegacyHangulText(decoded));
}

function inferDocumentIdFromSentenceId(sentenceId: string): string {
  const clean = sentenceId.trim();
  if (!clean) return 'document';
  const parts = clean.split('.');
  if (parts.length > 2) return parts.slice(0, -1).join('.');
  return clean;
}

function sentenceJsonIdNamespace(root: any, sourceFile: string, sourceFormat: SourceFormat): string {
  if (sourceFormat !== 'nikl-ci-sentence-json') return '';
  return safeIdentifier(text(root?.id) || sourceFileStem(sourceFile), 1);
}

function speakerIdFromNiklSpeaker(speaker: NlikSpeaker): string {
  return (
    speakerIdFromValue(speaker.id) ||
    speakerIdFromValue((speaker as Record<string, unknown>).speaker_id) ||
    speakerIdFromValue((speaker as Record<string, unknown>).dis_speaker_id)
  );
}

function speakerIdFromValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return (
      text(row.dis_speaker_id) ||
      text(row.original_speaker_id) ||
      text(row.speaker_id) ||
      text(row.id)
    );
  }
  return text(value);
}

function compactContextInferenceMetadata(value: unknown): unknown {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.map(compactContextInferenceMetadata);
  if (typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'form' && Array.isArray(child)) {
      result.formCount = child.length;
      result.formRange = compactFormRange(child);
    } else {
      const compacted = compactContextInferenceMetadata(child);
      if (compacted !== undefined) result[key] = compacted;
    }
  }
  return result;
}

function compactFormRange(forms: unknown[]): Record<string, string> | undefined {
  const first = forms[0] as Record<string, unknown> | undefined;
  const last = forms[forms.length - 1] as Record<string, unknown> | undefined;
  const firstId = text(first?.id);
  const lastId = text(last?.id);
  if (!firstId && !lastId) return undefined;
  return {
    ...(firstId ? { firstId } : {}),
    ...(lastId ? { lastId } : {})
  };
}

function detectTabularSourceFormat(row: Record<string, string>, sourceFile: string, delimiter: string): TabularSourceFormat {
  const keys = new Set(Object.keys(row));
  if (delimiter === '\t' || (keys.has('acceptability_label') && keys.has('sentence'))) return 'cola';
  if (keys.has('generation') && keys.has('sentence_id') && keys.has('form')) return 'paraphrase';
  if (
    keys.has('word_form') ||
    keys.has('dependent') ||
    keys.has('predicate_form') ||
    keys.has('za_predicate') ||
    keys.has('argument') ||
    (keys.has('word_id') && keys.has('label') && keys.has('sentence'))
  ) {
    return 'annotation';
  }
  if (keys.has('speaker') || /(?:MESSENGER|_OM_|온라인 대화)/iu.test(sourceFile)) return 'dialogue';
  return 'sentence';
}

function tabularDocumentInput(row: Record<string, string>, sourceFile: string, format: TabularSourceFormat): TabularDocumentInput {
  const sentenceId = text(row.sentence_id ?? row.sent_id ?? row.id);
  const docId = text(row.doc_id ?? row.document_id) || inferDocumentIdFromSentenceId(sentenceId) || sourceFileStem(sourceFile);
  const sourceFormat: SourceFormat = format === 'cola' ? 'nikl-cola-tsv' : format === 'dialogue' ? 'nikl-dialogue' : 'nikl-tabular';
  const category = inferTabularCategory(row, sourceFile, format);
  const date = text(row.date);
  return {
    docId,
    title: text(row.title) || docId,
    author: text(row.author),
    publisher: text(row.publisher),
    date,
    topic: text(row.topic ?? row.original_topic) || category,
    category,
    year: date.slice(0, 4),
    sourceFormat,
    extraMetadata: {
      tabularFormat: format,
      fileId: text(row.file_id),
      setting: parseLooseObject(row.setting)
    }
  };
}

function inferTabularCategory(row: Record<string, string>, sourceFile: string, format: TabularSourceFormat): string {
  if (format === 'cola') return COLA_CATEGORY;
  if (format === 'paraphrase') return PARAPHRASE_CATEGORY;
  const category = text(row.category);
  if (category) return category;
  if (/NEWSPAPER/iu.test(sourceFile)) return '신문 말뭉치';
  if (/WRITTEN/iu.test(sourceFile)) return '문어 말뭉치';
  if (/SPOKEN/iu.test(sourceFile)) return '구어 말뭉치';
  if (/(?:_OM_|온라인 대화)/iu.test(sourceFile)) return '온라인 대화 말뭉치';
  if (/(?:OPM|게시)/iu.test(sourceFile)) return '온라인 게시자료 말뭉치';
  if (/DP/iu.test(sourceFile)) return '구문 분석 말뭉치';
  if (/MP/iu.test(sourceFile)) return '형태 분석 말뭉치';
  if (/SR/iu.test(sourceFile)) return '의미역 분석 말뭉치';
  if (/ZA/iu.test(sourceFile)) return '무형 대용어 복원 말뭉치';
  return SENTENCE_CATEGORY;
}

function tabularProvidedToken(row: Record<string, string>): ProvidedToken | null {
  const surface =
    text(row.word_form) ||
    (text(row.sentence) && text(row.form) !== text(row.sentence) ? text(row.form) : '') ||
    text(row.token);
  const normalized = normalizeToken(surface);
  if (!surface || !normalized) return null;
  return {
    surface,
    normalized,
    lemma: optionalText(row.lemma),
    pos: optionalText(row.pos ?? row.tag ?? row.label),
    morphJson: JSON.stringify(row)
  };
}

function tabularRowNote(row: Record<string, string>, format: TabularSourceFormat): string {
  if (format === 'cola') {
    const label = text(row.acceptability_label);
    const sourceAnnotation = text(row.source_annotation);
    return [label ? `acceptability=${label}` : '', sourceAnnotation ? `annotation=${sourceAnnotation}` : ''].filter(Boolean).join(', ');
  }
  if (format === 'annotation') {
    const labels = [text(row.label), text(row.predicate_form), text(row.za_predicate), text(row.argument), text(row.argument_label ?? row.agrment_label)].filter(
      Boolean
    );
    return labels.slice(0, 4).join(', ');
  }
  return '';
}

function isFrameXmlDocument(xml: string): boolean {
  return /<frameFile\b|<frameset\b|<roleset\b/iu.test(xml);
}

function extractTagTexts(xml: string, tagName: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'giu');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    const value = stripXmlText(match[1] ?? '');
    if (value) values.push(value);
  }
  return values;
}

function extractFrameExamples(xml: string): string[] {
  const examples: string[] = [];
  const pattern = /<example\b[^>]*>([\s\S]*?)<\/example>/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    const text = extractTagText(match[1] ?? '', 'text');
    if (text) examples.push(text);
  }
  return examples;
}

function extractHistoricalHeader(xml: string, fileBase: string): {
  title: string;
  author: string;
  publisher: string;
  date: string;
  topic: string;
  year: string;
  metadata: Record<string, string>;
} {
  const title = extractTagText(xml, 'title', /lang\s*=\s*["']kor["']/iu) || extractTagText(xml, 'title') || fileBase;
  const fullName = extractTagText(xml, 'full_name');
  const date = extractTagText(xml, 'date');
  const author = extractTagText(xml, 'author');
  const publisher = extractTagText(xml, 'publisher');
  const topic = title || fullName || fileBase;

  return {
    title,
    author,
    publisher,
    date,
    topic,
    year: normalizeHistoricalYear(date),
    metadata: {
      title,
      fullName,
      niklName: extractTagText(xml, 'nikl_name'),
      generalName: extractTagText(xml, 'general_name'),
      author,
      publisher,
      date
    }
  };
}

function extractHistoricalXmlParts(xml: string): HistoricalXmlParts {
  const letters: HistoricalLetterRecord[] = [];
  const looseSents: HistoricalXmlSent[] = [];
  let current: HistoricalLetterRecord | null = null;
  const tokenPattern = /<letter\b([^>]*)>|<\/letter>|<sent\b([^>]*)>([\s\S]*?)<\/sent>/giu;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(xml))) {
    if (match[1] !== undefined) {
      current = { attrs: parseXmlAttributes(match[1]), sents: [] };
      letters.push(current);
    } else if (match[0].startsWith('</letter')) {
      current = null;
    } else if (match[2] !== undefined) {
      const sent = toHistoricalSent(match[2], match[3] ?? '');
      if (current) current.sents.push(sent);
      else looseSents.push(sent);
    }
  }

  return { letters, looseSents };
}

function toHistoricalSent(attrText: string, body: string): HistoricalXmlSent {
  return {
    attrs: parseXmlAttributes(attrText),
    text: stripXmlText(body)
  };
}

function parseXmlAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(value))) {
    attrs[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

function extractTagText(xml: string, tagName: string, attrPattern?: RegExp): string {
  const pattern = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'iu');
  let cursor = 0;
  while (cursor < xml.length) {
    const match = pattern.exec(xml.slice(cursor));
    if (!match) return '';
    if (!attrPattern || attrPattern.test(match[1] ?? '')) return stripXmlText(match[2] ?? '');
    cursor += match.index + match[0].length;
  }
  return '';
}

function stripXmlText(value: string): string {
  const stripped = value
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<[^>]+>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalizeLegacyHangulText(decodeXmlEntities(stripped));
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (entity, body: string) => {
    const normalized = body.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    if (normalized.startsWith('#x')) return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    if (normalized.startsWith('#')) return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    return entity;
  });
}

function normalizeHistoricalYear(date: string): string {
  const trimmed = date.trim();
  const year = /\d{3,4}/u.exec(trimmed);
  return year?.[0] ?? trimmed;
}

function safeIdentifier(value: string, fallback: number): string {
  const safe = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-|-$/gu, '');
  return safe || String(fallback);
}

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 10);
}

function historicalSentNote(attrs: Record<string, string>): string {
  const parts = [
    attrs.type ? `type=${attrs.type}` : '',
    attrs.lang ? `lang=${attrs.lang}` : '',
    attrs.page ? `page=${attrs.page}` : '',
    attrs.n ? `n=${attrs.n}` : ''
  ].filter(Boolean);
  return parts.join(', ');
}

function isSejongTeiText(content: string): boolean {
  return /<tei\.2\b|<!DOCTYPE\s+tei\.2/iu.test(content);
}

function extractSejongSourceInfo(body: string): Record<string, string> {
  const date = sejongBlockText(extractTagRaw(body, 'date'));
  const page = sejongBlockText(extractTagRaw(body, 'page'));
  return {
    ...(date ? { date } : {}),
    ...(page ? { page } : {})
  };
}

function extractTagRaw(xml: string, tagName: string): string {
  const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'iu').exec(xml);
  return match?.[1] ?? '';
}

function sejongBlockText(body: string): string {
  const lines = body
    .replace(/<[^>]+>/gu, '\n')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const tabbed = lines.map(parseSejongTabbedLine).filter((line): line is SejongTabbedLine => Boolean(line));
  if (tabbed.length > 0 && tabbed.length === lines.length) {
    return normalizeWhitespace(normalizeLegacyHangulText(tabbed.map((line) => line.surface).join(' ')));
  }
  return stripXmlText(body);
}

interface SejongTabbedLine {
  id: string;
  surface: string;
  analysis: string;
}

function parseSejongTabbedLine(line: string): SejongTabbedLine | null {
  const parts = line.split('\t');
  if (parts.length < 2 || !/^[A-Z0-9]+-\d+/iu.test(parts[0])) return null;
  return {
    id: parts[0].trim(),
    surface: normalizeLegacyHangulText((parts[1] ?? '').trim()),
    analysis: parts.slice(2).join('\t').trim()
  };
}

function firstSejongLineId(body: string): string {
  for (const line of body.split(/\r?\n/u)) {
    const parsed = parseSejongTabbedLine(line.trim());
    if (parsed?.id) return parsed.id;
  }
  return '';
}

function parseSejongProvidedTokens(body: string): ProvidedToken[] {
  const tokens: ProvidedToken[] = [];
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = parseSejongTabbedLine(rawLine.trim());
    if (!line?.analysis) continue;
    for (const segment of line.analysis.split(/\s+\+\s+/u)) {
      const parsed = parseSejongMorphSegment(segment, line);
      if (parsed) tokens.push(parsed);
    }
  }
  return tokens;
}

function parseSejongMorphSegment(segment: string, line: SejongTabbedLine): ProvidedToken | null {
  const trimmed = segment.trim();
  const slash = trimmed.lastIndexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const rawLemma = normalizeLegacyHangulText(trimmed.slice(0, slash).trim());
  const pos = trimmed.slice(slash + 1).trim();
  const lemma = rawLemma.replace(/__\d+$/u, '');
  const normalized = normalizeToken(lemma);
  if (!lemma || !normalized || !pos) return null;
  return {
    surface: lemma,
    normalized,
    lemma,
    pos,
    morphJson: JSON.stringify({ source: 'sejong', eojeol: line.surface, analysis: trimmed, id: line.id })
  };
}

function sejongNote(tag: string, source: Record<string, string>): string {
  const parts = [
    `tag=${tag}`,
    source.date ? `date=${source.date}` : '',
    source.page ? `page=${source.page}` : ''
  ].filter(Boolean);
  return parts.join(', ');
}

function inferSejongCategory(sourceFile: string): string {
  const normalized = sourceFile.normalize('NFKC');
  if (/병렬/iu.test(normalized)) return `${SEJONG_CATEGORY} > 병렬`;
  if (/역사/iu.test(normalized)) return `${SEJONG_CATEGORY} > 역사`;
  if (/현대\s*구어|현대구어/iu.test(normalized)) return `${SEJONG_CATEGORY} > 현대 구어`;
  if (/현대/iu.test(normalized)) return `${SEJONG_CATEGORY} > 현대 문어`;
  return SEJONG_CATEGORY;
}

function inferSejongLayer(sourceFile: string): string {
  const normalized = sourceFile.normalize('NFKC');
  if (/형태의미분석/iu.test(normalized)) return '형태의미분석';
  if (/형태분석/iu.test(normalized)) return '형태분석';
  if (/구문분석/iu.test(normalized)) return '구문분석';
  if (/원시/iu.test(normalized)) return '원시';
  return '텍스트';
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
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
    const surface = normalizeLegacyHangulText(value);
    const normalized = normalizeToken(surface);
    return normalized ? { surface, normalized, lemma: null, pos: null, morphJson: null } : null;
  }
  if (!value || typeof value !== 'object') return null;

  const row = value as Record<string, unknown>;
  const surface = normalizeLegacyHangulText(text(row.surface ?? row.form ?? row.text ?? row.word ?? row.token ?? row.orth));
  const normalized = normalizeToken(surface);
  if (!surface || !normalized) return null;

  return {
    surface,
    normalized,
    lemma: optionalLegacyHangulText(row.lemma ?? row.lexeme ?? row.base),
    pos: optionalText(row.pos ?? row.tag ?? row.upos ?? row.xpos ?? row.label),
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

function optionalLegacyHangulText(value: unknown): string | null {
  const result = normalizeLegacyHangulText(text(value));
  return result || null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === null || value === undefined) return [];
  return [value as T];
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
    } else if (
      JSON_ENTRY.test(entry.name) ||
      CSV_ENTRY.test(entry.name) ||
      TSV_ENTRY.test(entry.name) ||
      XML_ENTRY.test(entry.name) ||
      TXT_ENTRY.test(entry.name) ||
      ZIP_ENTRY.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function readFileText(filePath: string): Promise<string> {
  return streamToString(createReadStream(filePath));
}

function readFileBuffer(filePath: string): Promise<Buffer> {
  return streamToBuffer(createReadStream(filePath));
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: false }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('ZIP 파일을 열 수 없습니다.'));
      else resolve(zip);
    });
  });
}

function openZipBuffer(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: false }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('ZIP 버퍼를 열 수 없습니다.'));
      else resolve(zip);
    });
  });
}

function waitForZipClose(zip: yauzl.ZipFile): Promise<void> {
  return new Promise((resolve) => {
    zip.once('close', resolve);
  });
}

function removeTempDirectoryBestEffort(dirPath: string): void {
  try {
    rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`임시 nested ZIP 폴더 정리에 실패했습니다. 다음 실행에서 다시 정리할 수 있습니다: ${dirPath}`, error);
  }
}

function zipEntryName(entry: yauzl.Entry): string {
  const fileName = entry.fileName as unknown;
  if (Buffer.isBuffer(fileName)) return decodeCorpusText(fileName);
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
  return streamToBuffer(stream).then(decodeCorpusText);
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks)));
  });
}

function decodeCorpusText(buffer: Buffer): string {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le').replace(/^\uFEFF/u, '');
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return swapUtf16Bytes(buffer.subarray(2)).toString('utf16le');
  }
  const sampleLength = Math.min(buffer.length, 400);
  let oddZeroes = 0;
  for (let index = 1; index < sampleLength; index += 2) {
    if (buffer[index] === 0) oddZeroes += 1;
  }
  if (sampleLength > 20 && oddZeroes > sampleLength / 4) return buffer.toString('utf16le').replace(/^\uFEFF/u, '');

  const utf8 = buffer.toString('utf8').replace(/^\uFEFF/u, '');
  const utf8Loss = countDecodeReplacementCharacters(utf8);
  if (utf8Loss === 0) return utf8;

  const legacyKorean = decodeLegacyKoreanText(buffer);
  if (
    legacyKorean &&
    countDecodeReplacementCharacters(legacyKorean) < utf8Loss &&
    (looksLikeKoreanText(legacyKorean) || utf8Loss > 10)
  ) {
    return legacyKorean;
  }
  return utf8;
}

function decodeLegacyKoreanText(buffer: Buffer): string {
  for (const encoding of ['windows-949', 'euc-kr']) {
    try {
      return new TextDecoder(encoding).decode(buffer).replace(/^\uFEFF/u, '');
    } catch {
      // Ignore unsupported labels and try the next compatible Korean legacy encoding.
    }
  }
  return '';
}

function countDecodeReplacementCharacters(value: string): number {
  let count = 0;
  for (const char of value) {
    if (char === '\uFFFD') count += 1;
  }
  return count;
}

function looksLikeKoreanText(value: string): boolean {
  return /[\uac00-\ud7a3]/u.test(value) || isSejongTeiText(value);
}

function swapUtf16Bytes(buffer: Buffer): Buffer {
  const swapped = Buffer.from(buffer);
  for (let index = 0; index + 1 < swapped.length; index += 2) {
    const left = swapped[index];
    swapped[index] = swapped[index + 1];
    swapped[index + 1] = left;
  }
  return swapped;
}

function zeroCounters(): ImportCounters {
  return { fileCount: 0, documentCount: 0, utteranceCount: 0, tokenCount: 0 };
}

function validateImportCounters(counters: ImportCounters, sourcePath: string): void {
  if (counters.documentCount > 0 && counters.utteranceCount === 0) {
    throw new Error(
      `문서를 ${counters.documentCount.toLocaleString('ko-KR')}개 찾았지만 검색 가능한 본문 단위를 하나도 만들지 못했습니다. ` +
        `말뭉치 구조가 importer와 맞지 않을 수 있습니다: ${sourcePath}`
    );
  }
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

function isNewspaperSource(sourcePath: string): boolean {
  return /NIKL_?NEWSPAPER/iu.test(path.basename(sourcePath).normalize('NFKC'));
}

function isNewspaperCsvSource(sourcePath: string): boolean {
  const name = path.basename(sourcePath).normalize('NFKC');
  return isNewspaperSource(sourcePath) && /CSV/iu.test(name);
}

function isPreferredNewspaperSource(sourcePath: string): boolean {
  return isNewspaperSource(sourcePath) && !isNewspaperCsvSource(sourcePath);
}

function newspaperSourceKey(sourcePath: string): string {
  const name = path.basename(sourcePath).normalize('NFKC');
  const year = /(20\d{2})/u.exec(name);
  return year?.[1] ?? 'all';
}

function shouldImportNestedZip(name: string): boolean {
  const normalized = name.normalize('NFKC').replace(/\\/gu, '/');
  return /\/02_[^/]*\/[123]\.\s*[^/]+\.zip$/iu.test(normalized);
}
