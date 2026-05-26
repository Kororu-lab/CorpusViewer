import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CorpusDatabase } from '../src/main/database';
import {
  CorpusImporter,
  detectJsonSourceFormat,
  detectProvidedTokens,
  extractHistoricalXmlDocuments,
  extractSejongTeiDocuments,
  selectImportSources
} from '../src/main/importer';
import { CorpusServices } from '../src/main/services';
import { tokenizeText } from '../src/main/tokenizer';
import { normalizeLegacyHangulText } from '../src/shared/textNormalization';

describe('CorpusImporter POS readiness', () => {
  it('detects future embedded POS token arrays while raw tokens remain derivable', () => {
    const utterance = {
      form: '밥을 먹고 싶다',
      tokens: [
        { surface: '밥', lemma: '밥', pos: 'NNG' },
        { surface: '먹고', lemma: '먹다', pos: 'VV' },
        { surface: '싶다', lemma: '싶다', pos: 'VX' }
      ]
    };

    expect(tokenizeText(utterance.form).map((token) => token.normalized)).toEqual(['밥을', '먹고', '싶다']);
    expect(detectProvidedTokens(utterance)).toEqual([
      { surface: '밥', normalized: '밥', lemma: '밥', pos: 'NNG', morphJson: JSON.stringify(utterance.tokens[0]) },
      { surface: '먹고', normalized: '먹고', lemma: '먹다', pos: 'VV', morphJson: JSON.stringify(utterance.tokens[1]) },
      { surface: '싶다', normalized: '싶다', lemma: '싶다', pos: 'VX', morphJson: JSON.stringify(utterance.tokens[2]) }
    ]);
  });

  it('skips duplicate messenger CSV sources when messenger JSON is present', () => {
    const sources = [
      'C:\\data\\NIKL_DIALOGUE_2024_v1.0.zip',
      'C:\\data\\NIKL_MESSENGER_CSV.zip',
      'C:\\data\\NIKL_MESSENGER_v2.0_JSON.zip'
    ];

    expect(selectImportSources(sources)).toEqual([
      'C:\\data\\NIKL_DIALOGUE_2024_v1.0.zip',
      'C:\\data\\NIKL_MESSENGER_v2.0_JSON.zip'
    ]);
  });

  it('skips duplicate newspaper CSV sources when matching JSON sources are present', () => {
    const sources = [
      'C:\\data\\NIKL_NEWSPAPER_2022_CSV.zip',
      'C:\\data\\NIKLNEWSPAPER_2022_v1.0_JSON.zip',
      'C:\\data\\NIKL_NEWSPAPER_CSV.zip',
      'C:\\data\\NIKL_NEWSPAPER_v2.0_JSON.zip',
      'C:\\data\\NIKL_NEWSPAPER_2020_CSV.zip'
    ];

    expect(selectImportSources(sources)).toEqual([
      'C:\\data\\NIKLNEWSPAPER_2022_v1.0_JSON.zip',
      'C:\\data\\NIKL_NEWSPAPER_v2.0_JSON.zip',
      'C:\\data\\NIKL_NEWSPAPER_2020_CSV.zip'
    ]);
  });

  it('normalizes Hanyang PUA old Hangul into standard jamo text', () => {
    expect(normalizeLegacyHangulText('\ue57b일신문 \uf537\ue285 \ue669셩')).toBe(
      '\u1106\u11a1일신문 \u1112\u119e\u1102\u119e\u11ab \u1107\u11a1\u11a8셩'
    );
  });

  const nativeSqliteIt = canOpenBetterSqlite() ? it : it.skip;

  nativeSqliteIt('imports into compact schema v2 and keeps provided POS tokens searchable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corpusviewer-test-'));
    const database = new CorpusDatabase(path.join(dir, 'corpusviewer.sqlite'));

    try {
      const jsonPath = path.join(dir, 'sample.json');
      writeFileSync(
        jsonPath,
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
                  form: '밥을 먹다',
                  original_form: '밥을 먹다',
                  tokens: [
                    { surface: '밥을', lemma: '밥', pos: 'NNG' },
                    { surface: '먹다', lemma: '먹다', pos: 'VV' }
                  ]
                }
              ]
            }
          ]
        }),
        'utf8'
      );

      const importer = new CorpusImporter(database, () => undefined);
      const corpus = await importer.importPath(jsonPath, { name: 'sample' });
      const services = new CorpusServices(database);
      const posSearch = services.search({
        query: '[pos="VV"]',
        mode: 'cql',
        field: 'form',
        contextSize: 1,
        limit: 10,
        offset: 0,
        filters: { tokenSource: 'provided' }
      });

      expect(corpus.status).toBe('ready');
      expect(corpus.documentCount).toBe(1);
      expect(corpus.utteranceCount).toBe(1);
      expect(database.db.pragma('user_version', { simple: true })).toBe(3);
      expect(posSearch.results).toHaveLength(1);
      expect(posSearch.results[0].kwic.hit).toEqual(['먹다']);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts 21st Century Sejong TEI text rows and provided POS tokens', () => {
    const text = `<!DOCTYPE tei.2 SYSTEM "tei2.dtd">
      <tei.2>
      <teiHeader><title>세종 표본</title><author>국립국어연구원</author><date>1993</date><idno>BTAA0001</idno></teiHeader>
      <text><body>
      <source><date>BTAA0001-00000001\t1993/06/08\t1993/SN + //SP + 06/SN + //SP + 08/SN</date><page>BTAA0001-00000002\t19\t19/SN</page></source>
      <p>
      BTAA0001-00000012\t프랑스의\t프랑스/NNP + 의/JKG
      BTAA0001-00000013\t세계적인\t세계__02/NNG + 적/XSN + 이/VCP + ᆫ/ETM
      BTAA0001-00000014\t문장이다.\t문장/NNG + 이/VCP + 다/EF + ./SF
      </p>
      </body></text></tei.2>`;

    const docs = extractSejongTeiDocuments(text, '1. 현대/형태분석_말뭉치/BTAA0001.txt');

    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      title: '세종 표본',
      category: '21세기 세종계획 > 현대 문어',
      year: '1993'
    });
    expect(docs[0].docId).toMatch(/^BTAA0001-[0-9a-f]{10}$/u);
    expect(docs[0].rows).toHaveLength(1);
    expect(docs[0].rows[0].id).toContain(docs[0].docId);
    expect(docs[0].rows[0].text).toBe('프랑스의 세계적인 문장이다.');
    expect(docs[0].rows[0].source).toMatchObject({ date: '1993/06/08', page: '19' });
    expect(docs[0].rows[0].providedTokens.map((token) => [token.lemma, token.pos])).toContainEqual(['세계', 'NNG']);
  });

  it('keeps Sejong document and utterance ids unique across repeated filenames', () => {
    const text = `<tei.2><teiHeader><title>반복 파일명</title><idno>BTAA0001</idno></teiHeader><text><body><p>
      BTAA0001-00000012\t첫 문장\t첫/MM + 문장/NNG
      </p></body></text></tei.2>`;

    const modern = extractSejongTeiDocuments(text, '1. 현대/형태분석_말뭉치/BTAA0001.txt');
    const historical = extractSejongTeiDocuments(text, '2. 역사/형태분석_말뭉치/BTAA0001.txt');

    expect(modern[0].docId).not.toBe(historical[0].docId);
    expect(modern[0].rows[0].id).not.toBe(historical[0].rows[0].id);
  });

  it('extracts historical XML letter documents with sent metadata using tolerant scanning', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <doc>
        <teiHeader>
          <titleStmt>
            <title lang="kor">역사 문헌</title>
            <full_name>역사 문헌 전체 이름</full_name>
            <date>17세기</date>
          </titleStmt>
        </teiHeader>
        <letter n="01" sender="갑" writer="갑" receiver="을" year="1682년">
          <sent type="main" lang="kor" page="01" n="01">ᄒᆞᆫ 번 편지ᄒᆞ온 후</sent>
          <sent type="main" lang="kor" page="01" n="02">다시 쇼식을 통티 못ᄒᆞ오니</sent>
        </letter>
        <letter n="02" sender="을" year="1683년">
          <sent type="main" lang="kor" page="02" n="01">답장을 보내노라</sent>
        </letter>
      </doc>`;

    const docs = extractHistoricalXmlDocuments(xml, 'HXRW-test.xml');

    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      docId: 'HXRW-test.letter.1-01',
      title: '역사 문헌',
      topic: '역사 문헌',
      year: '1682',
      category: '역사 말뭉치'
    });
    expect(docs[0].sents).toHaveLength(2);
    expect(docs[0].sents[0]).toMatchObject({
      text: 'ᄒᆞᆫ 번 편지ᄒᆞ온 후',
      attrs: { type: 'main', lang: 'kor', page: '01', n: '01' }
    });
    expect(docs[1].sents[0].text).toBe('답장을 보내노라');
  });

  it('extracts sent rows from malformed historical XML without strict XML parsing', () => {
    const malformed = `<doc><teiHeader><title>문헌</title><date>1876년</date></teiHeader>
      <sent type="title" lang="chi" page="1a" n="1">歌曲源流</sent>
      <sent type="main" lang="kor" page="6a" n="1">黃河水 맑다터니 聖人이 나시도다</sent>
      </broken>`;

    const docs = extractHistoricalXmlDocuments(malformed, 'HXRW-malformed.xml');

    expect(docs).toHaveLength(1);
    expect(docs[0].docId).toBe('HXRW-malformed');
    expect(docs[0].sents.map((sent) => sent.text)).toEqual(['歌曲源流', '黃河水 맑다터니 聖人이 나시도다']);
  });

  it('keeps historical XML sent rows that appear outside letter blocks', () => {
    const xml = `<doc>
      <teiHeader><title>혼합 문헌</title><date>1900년</date></teiHeader>
      <sent type="head" lang="kor" n="1">문서 머리</sent>
      <sent type="anno" lang="chi" n="2">   </sent>
      <letter n="01"><sent type="main" lang="kor" n="1">편지 본문</sent></letter>
    </doc>`;

    const docs = extractHistoricalXmlDocuments(xml, 'HXRW-mixed.xml');

    expect(docs).toHaveLength(2);
    expect(docs.find((doc) => doc.docId === 'HXRW-mixed')?.sents.map((sent) => sent.text)).toEqual(['문서 머리', '']);
    expect(docs.find((doc) => doc.docId === 'HXRW-mixed.letter.1-01')?.sents.map((sent) => sent.text)).toEqual(['편지 본문']);
  });

  nativeSqliteIt('imports CI nested dialogue JSON by flattening inner documents', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corpusviewer-ci-test-'));
    const database = new CorpusDatabase(path.join(dir, 'corpusviewer.sqlite'));

    try {
      const jsonPath = path.join(dir, 'ci.json');
      const root = {
        id: 'MXCI',
        metadata: { category: '온라인 대화 > 2인 대화', year: '2023' },
        document: [
          {
            id: 'OUTER-1',
            metadata: { year: '2021' },
            document: [
              {
                id: 'INNER-1',
                metadata: {
                  title: '온라인 대화',
                  date: '20210905',
                  topic: '식음료',
                  speaker: [{ id: '1', age: '40대 이상', sex: '여성', occupation: '기능원' }],
                  setting: { relation: '낯선 사람' }
                },
                utterance: [
                  {
                    id: 'INNER-1.1',
                    form: '국민지원금 신청 일이 다가오네요',
                    original_form: '국민지원금 신청 일이 다가오네요',
                    speaker_id: '1',
                    time: '20210905 10:17'
                  }
                ],
                inference: { reaction: { output: '화자가 반응한다.', reference: ['INNER-1.1'] } }
              }
            ]
          }
        ]
      };
      writeFileSync(jsonPath, JSON.stringify(root), 'utf8');

      expect(detectJsonSourceFormat(root)).toBe('nikl-ci-nested-dialogue');
      const importer = new CorpusImporter(database, () => undefined);
      const corpus = await importer.importPath(jsonPath, { name: 'ci' });
      const document = database.db
        .prepare('SELECT doc_id AS docId, topic, category, metadata_json AS metadataJson FROM documents WHERE corpus_id = ?')
        .get(corpus.id) as { docId: string; topic: string; category: string; metadataJson: string };
      const speaker = database.db
        .prepare('SELECT speaker_id AS speakerId, sex, age FROM speakers WHERE corpus_id = ? AND doc_id = ?')
        .get(corpus.id, 'INNER-1') as { speakerId: string; sex: string; age: string };

      expect(corpus.documentCount).toBe(1);
      expect(corpus.utteranceCount).toBe(1);
      expect(document).toMatchObject({ docId: 'INNER-1', topic: '식음료', category: '온라인 대화 > 2인 대화' });
      expect(JSON.parse(document.metadataJson)).toMatchObject({
        sourceFormat: 'nikl-ci-nested-dialogue',
        inference: { reaction: { output: '화자가 반응한다.' } }
      });
      expect(speaker).toMatchObject({ speakerId: '1', sex: '여성', age: '40대 이상' });
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  nativeSqliteIt('imports IU web JSON sentences and links immoral-expression annotations', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corpusviewer-iu-test-'));
    const database = new CorpusDatabase(path.join(dir, 'corpusviewer.sqlite'));

    try {
      const jsonPath = path.join(dir, 'iu.json');
      const root = {
        id: 'EXIU',
        metadata: { category: '웹 > 리뷰 > 누리소통망', year: '2023' },
        document: [
          {
            id: 'ESRW.1',
            metadata: { title: 'NA', date: '20180412', topic: '민감 자료_비윤리적 게시자료' },
            paragraph: [{ id: 'ESRW.1.1', form: '문단', original_form: '문단' }],
            sentence: [
              { id: 'ESRW.1.1.1', form: '대학 떨어지면 엠생되는거 아냐ㅠ?', original_form: '대학 떨어지면 엠생되는거 아냐ㅠ?' },
              { id: 'ESRW.1.1.2', form: '너무무서웡', original_form: '너무무서웡' }
            ],
            immoral_expression: [
              {
                expression_id: 'ESRW.1.1.1',
                expression_form: '대학 떨어지면 엠생되는거 아냐ㅠ?',
                expression: { sentiment: '부정적', intensity: 3 }
              }
            ]
          }
        ]
      };
      writeFileSync(jsonPath, JSON.stringify(root), 'utf8');

      expect(detectJsonSourceFormat(root)).toBe('nikl-iu-web');
      const importer = new CorpusImporter(database, () => undefined);
      const corpus = await importer.importPath(jsonPath, { name: 'iu' });
      const row = database.db
        .prepare('SELECT speaker_id AS speakerId, metadata_json AS metadataJson FROM utterances WHERE corpus_id = ? AND utterance_id = ?')
        .get(corpus.id, 'ESRW.1.1.1') as { speakerId: string; metadataJson: string };
      const metadata = JSON.parse(row.metadataJson);

      expect(corpus.documentCount).toBe(1);
      expect(corpus.utteranceCount).toBe(2);
      expect(row.speakerId).toBe('text');
      expect(metadata).toMatchObject({
        sourceFormat: 'nikl-iu-web',
        immoralExpression: [{ expression: { intensity: 3 } }]
      });
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  nativeSqliteIt('imports paragraph-only JSON as searchable text rows', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corpusviewer-paragraph-test-'));
    const database = new CorpusDatabase(path.join(dir, 'corpusviewer.sqlite'));

    try {
      const jsonPath = path.join(dir, 'newspaper.json');
      const root = {
        id: 'NIRW',
        metadata: { category: '신문 > 인터넷 기반 신문', year: '2024' },
        document: [
          {
            id: 'NIRW.1',
            metadata: { title: '뉴스 기사', author: '기자', publisher: '신문사', date: '20240101', topic: '경제' },
            paragraph: [
              { id: 'NIRW.1.1', form: '<p>첫 문단입니다.</p>' },
              { id: 'NIRW.1.2', form: '둘째 문단입니다.' }
            ]
          }
        ]
      };
      writeFileSync(jsonPath, JSON.stringify(root), 'utf8');

      expect(detectJsonSourceFormat(root)).toBe('nikl-paragraph-json');
      const importer = new CorpusImporter(database, () => undefined);
      const corpus = await importer.importPath(jsonPath, { name: 'paragraph' });
      const forms = database.db
        .prepare('SELECT form FROM utterances WHERE corpus_id = ? ORDER BY sequence')
        .all(corpus.id)
        .map((row: any) => row.form);

      expect(corpus.documentCount).toBe(1);
      expect(corpus.utteranceCount).toBe(2);
      expect(forms).toEqual(['첫 문단입니다.', '둘째 문단입니다.']);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  nativeSqliteIt('reimports stale ready paragraph corpora that have documents but no utterances', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corpusviewer-stale-paragraph-test-'));
    const database = new CorpusDatabase(path.join(dir, 'corpusviewer.sqlite'));

    try {
      const jsonPath = path.join(dir, 'newspaper.json');
      const root = {
        id: 'NIRW',
        metadata: { category: '신문 > 인터넷 기반 신문', year: '2024' },
        document: [
          {
            id: 'NIRW.1',
            metadata: { title: '뉴스 기사', date: '20240101', topic: '경제' },
            paragraph: [{ id: 'NIRW.1.1', form: '재색인할 본문입니다.' }]
          }
        ]
      };
      writeFileSync(jsonPath, JSON.stringify(root), 'utf8');

      const importer = new CorpusImporter(database, () => undefined);
      const first = await importer.importPath(jsonPath, { name: 'paragraph' });
      database.updateCorpus({ ...first, status: 'ready', documentCount: 1, utteranceCount: 0, tokenCount: 0 });

      const second = await importer.importPath(jsonPath, { name: 'paragraph' });
      const counts = database.db
        .prepare('SELECT COUNT(DISTINCT doc_id) AS documents, COUNT(*) AS utterances FROM utterances WHERE corpus_id = ?')
        .get(second.id) as { documents: number; utterances: number };

      expect(second.id).toBe(first.id);
      expect(second.status).toBe('ready');
      expect(second.documentCount).toBe(1);
      expect(second.utteranceCount).toBe(1);
      expect(counts).toEqual({ documents: 1, utterances: 1 });
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  nativeSqliteIt('fails imports that create documents but no searchable text rows', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corpusviewer-empty-doc-test-'));
    const database = new CorpusDatabase(path.join(dir, 'corpusviewer.sqlite'));

    try {
      const jsonPath = path.join(dir, 'empty-doc.json');
      writeFileSync(
        jsonPath,
        JSON.stringify({
          metadata: { category: '신문', year: '2024' },
          document: [{ id: 'DOC.1', metadata: { title: '빈 기사', topic: '사회' } }]
        }),
        'utf8'
      );

      const importer = new CorpusImporter(database, () => undefined);
      await expect(importer.importPath(jsonPath, { name: 'empty-doc' })).rejects.toThrow('검색 가능한 본문 단위');

      const corpus = database.listCorpora()[0];
      expect(corpus.status).toBe('failed');
      expect(corpus.documentCount).toBe(1);
      expect(corpus.utteranceCount).toBe(0);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  nativeSqliteIt('imports sentence annotation JSON and indexes provided word tokens', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corpusviewer-sentence-test-'));
    const database = new CorpusDatabase(path.join(dir, 'corpusviewer.sqlite'));

    try {
      const jsonPath = path.join(dir, 'dp.json');
      const root = {
        id: 'NXDP',
        metadata: { category: '신문 > 전국 종합지', year: '2024', annotation_level: ['구문 분석'] },
        document: [
          {
            id: 'DOC.1',
            metadata: { title: '분석 기사', date: '20240101', topic: '사회' },
            sentence: [
              {
                id: 'DOC.1.1',
                form: '문장을 분석한다.',
                word: [
                  { id: 1, form: '문장을', label: 'NP' },
                  { id: 2, form: '분석한다.', label: 'VP' }
                ]
              }
            ]
          }
        ]
      };
      writeFileSync(jsonPath, JSON.stringify(root), 'utf8');

      expect(detectJsonSourceFormat(root)).toBe('nikl-sentence-json');
      const importer = new CorpusImporter(database, () => undefined);
      const corpus = await importer.importPath(jsonPath, { name: 'sentence' });
      const providedCount = database.db
        .prepare("SELECT COUNT(*) AS count FROM token_occurrences WHERE corpus_id = ? AND source = 'provided'")
        .get(corpus.id) as { count: number };

      expect(corpus.documentCount).toBe(1);
      expect(corpus.utteranceCount).toBe(1);
      expect(providedCount.count).toBe(2);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  nativeSqliteIt('imports CI 2024 sentence JSON splits without colliding ids', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corpusviewer-ci2024-test-'));
    const database = new CorpusDatabase(path.join(dir, 'corpusviewer.sqlite'));

    try {
      const makeRoot = (id: string, annotationLevel: string) => ({
        id,
        metadata: { category: '구어 > 사적대화 > 일상대화', year: '2024', annotation_level: annotationLevel },
        document: [
          {
            id: 'SDRW2200000917.1',
            metadata: {
              title: '2인 일상 대화',
              date: '20220929',
              topic: '스포츠',
              speaker: [
                {
                  id: { original_speaker_id: 'SD2201496', dis_speaker_id: '1' },
                  age: '20대',
                  sex: '남성',
                  occupation: '기타'
                }
              ]
            },
            sentence: [{ id: 'SDRW2200000917.1.1.1', form: '최근에', dis_speaker_id: '1' }],
            CI: [
              {
                discourse: {
                  discourse_number: 'SDRW2200000917.D1',
                  form: [{ id: 'SDRW2200000917.1.1.1', form: '최근에' }]
                },
                inference: { cause: { infstmt: '화자1은 운동 이야기를 한다.' } }
              }
            ]
          }
        ]
      });
      const buildRoot = makeRoot('SDCI2402502282', '맥락 추론');
      const evalRoot = makeRoot('SDCI2412502282', '맥락 추론 평가');
      writeFileSync(path.join(dir, 'SDCI2402502282.json'), JSON.stringify(buildRoot), 'utf8');
      writeFileSync(path.join(dir, 'SDCI2412502283.json'), JSON.stringify(evalRoot), 'utf8');

      expect(detectJsonSourceFormat(buildRoot)).toBe('nikl-ci-sentence-json');
      const importer = new CorpusImporter(database, () => undefined);
      const corpus = await importer.importPath(dir, { name: 'NIKL_CI_2024_v.1.0' });
      const rows = database.db
        .prepare('SELECT doc_id AS docId, utterance_id AS utteranceId, speaker_id AS speakerId, metadata_json AS metadataJson FROM utterances ORDER BY utterance_id')
        .all() as Array<{ docId: string; utteranceId: string; speakerId: string; metadataJson: string }>;
      const docMetadata = database.db
        .prepare('SELECT metadata_json AS metadataJson FROM documents ORDER BY doc_id LIMIT 1')
        .get() as { metadataJson: string };

      expect(corpus.documentCount).toBe(2);
      expect(corpus.utteranceCount).toBe(2);
      expect(rows.map((row) => row.utteranceId)).toEqual([
        'SDCI2402502282:SDRW2200000917.1.1.1',
        'SDCI2412502282:SDRW2200000917.1.1.1'
      ]);
      expect(rows.every((row) => row.speakerId === '1')).toBe(true);
      expect(JSON.parse(docMetadata.metadataJson).contextInference[0].discourse.formCount).toBe(1);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  nativeSqliteIt('imports tabular sentence and CoLA TSV rows', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'corpusviewer-tabular-test-'));
    const database = new CorpusDatabase(path.join(dir, 'corpusviewer.sqlite'));

    try {
      const csvPath = path.join(dir, 'NIKL_NEWSPAPER_2024.csv');
      writeFileSync(
        csvPath,
        [
          'file_id,doc_id,title,author,publisher,date,topic,original_topic,sentence_id,sentence',
          'NIRW,NIRW.1,기사,기자,신문사,20240101,경제,경제,NIRW.1.1,신문 문장입니다.'
        ].join('\n'),
        'utf8'
      );
      const tsvPath = path.join(dir, 'NIKL_CoLA.tsv');
      writeFileSync(
        tsvPath,
        ['index\tacceptability_label\tsource_annotation\tsentence', '1\t0\t*\t문법성이 어색한 문장입니다.'].join('\n'),
        'utf8'
      );

      const importer = new CorpusImporter(database, () => undefined);
      const csvCorpus = await importer.importPath(csvPath, { name: 'csv' });
      const tsvCorpus = await importer.importPath(tsvPath, { name: 'tsv' });

      expect(csvCorpus.utteranceCount).toBe(1);
      expect(tsvCorpus.utteranceCount).toBe(1);
      expect(
        database.db.prepare('SELECT note FROM utterances WHERE corpus_id = ?').get(tsvCorpus.id)
      ).toMatchObject({ note: 'acceptability=0, annotation=*' });
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function canOpenBetterSqlite(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), 'corpusviewer-native-probe-'));
  try {
    const database = new CorpusDatabase(path.join(dir, 'probe.sqlite'));
    database.close();
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
