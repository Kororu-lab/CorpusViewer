import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CorpusDatabase } from '../src/main/database';
import { CorpusImporter, detectProvidedTokens, selectImportSources } from '../src/main/importer';
import { CorpusServices } from '../src/main/services';
import { tokenizeText } from '../src/main/tokenizer';

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
      expect(database.db.pragma('user_version', { simple: true })).toBe(2);
      expect(posSearch.results).toHaveLength(1);
      expect(posSearch.results[0].kwic.hit).toEqual(['먹다']);
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
