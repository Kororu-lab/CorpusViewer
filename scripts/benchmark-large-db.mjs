import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const dbPath = process.argv[2] ?? path.join(root, 'release', 'win-unpacked', 'CorpusViewerData', 'corpusviewer.sqlite');

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

function sqlite(sql) {
  const result = spawnSync('sqlite3', ['-readonly', dbPath, sql], {
    cwd: root,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `sqlite3 failed: ${sql}`);
  }
  return result.stdout.trim();
}

function timed(label, sql) {
  const start = performance.now();
  const output = sqlite(sql);
  const ms = performance.now() - start;
  console.log(`${label}: ${ms.toFixed(1)}ms${output ? ` | ${output.split(/\r?\n/u)[0]}` : ''}`);
}

const corpusId = sqlite("SELECT id FROM corpora WHERE status = 'ready' LIMIT 1;");
console.log(`DB: ${dbPath}`);
console.log(`schema_version: ${sqlite('PRAGMA user_version;')}`);
console.log(`counts: ${sqlite("SELECT 'corpora=' || COUNT(*) FROM corpora;")} ${sqlite("SELECT 'docs=' || COUNT(*) FROM documents;")} ${sqlite("SELECT 'utterances=' || COUNT(*) FROM utterances;")}`);

timed('explore tree stats', 'SELECT COUNT(*) FROM explore_topic_stats;');
if (corpusId) {
  timed(
    'listDocuments first page',
    `SELECT d.doc_id, COALESCE(ds.utterance_count, 0)
     FROM documents d
     LEFT JOIN document_stats ds ON ds.corpus_id = d.corpus_id AND ds.doc_id = d.doc_id
     WHERE d.corpus_id = '${corpusId.replace(/'/gu, "''")}'
     ORDER BY d.doc_id
     LIMIT 201;`
  );
}
timed(
  'token exact 진짜',
  `SELECT COUNT(*)
   FROM token_occurrences
   WHERE source = 'raw' AND term_id = (SELECT id FROM terms WHERE value = '진짜');`
);
timed(
  'FTS LIKE 진짜',
  `SELECT COUNT(*)
   FROM utterance_fts
   WHERE form LIKE '%진짜%';`
);
timed(
  'CQL distance 진짜~좋다 first page',
  `SELECT COUNT(*)
   FROM (
     SELECT a.utterance_rowid
     FROM token_occurrences a
     JOIN token_occurrences b ON b.utterance_rowid = a.utterance_rowid AND b.source = a.source
     WHERE a.source = 'raw'
       AND a.term_id = (SELECT id FROM terms WHERE value = '진짜')
       AND b.term_id = (SELECT id FROM terms WHERE value = '좋다')
       AND b.token_index - a.token_index - 1 BETWEEN 0 AND 3
     LIMIT 101
   );`
);
