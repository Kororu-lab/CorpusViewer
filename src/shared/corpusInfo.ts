export type CorpusSourceFormat =
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
  | 'sejong-tei-text'
  | 'unknown';

export type CorpusUnitLabel = '발화' | '문장';

export interface CorpusLike {
  name?: string;
  sourcePath?: string;
  sourceType?: string;
}

export function displayCorpusName(input: CorpusLike | string): string {
  const raw = typeof input === 'string' ? input : `${input.name ?? ''} ${input.sourcePath ?? ''}`;
  const source = raw.normalize('NFKC');

  if (/NIKL_DIALOGUE_2020|DIALOGUE_2020/iu.test(source)) return '일상 대화 말뭉치 2020';
  if (/NIKL_DIALOGUE_2023|DIALOGUE_2023/iu.test(source)) return '일상 대화 말뭉치 2023';
  if (/NIKL_DIALOGUE_2024|DIALOGUE_2024/iu.test(source)) return '일상 대화 말뭉치 2024';
  if (/NIKL_MESSENGER|MESSENGER/iu.test(source)) return '메신저 말뭉치';
  if (/NIKL_CI_2023|CI_2023/iu.test(source)) return '맥락 추론 말뭉치 2023';
  if (/NIKL_CI_2024|CI_2024/iu.test(source)) return '맥락 추론 말뭉치 2024';
  if (/NIKL_IU_2023|IU_2023/iu.test(source)) return '비윤리 문장 탐지 말뭉치 2023';
  if (/NIKL_NEWSPAPER|NIKLNEWSPAPER|NEWSPAPER/iu.test(source)) return '신문 말뭉치';
  if (/NIKL_WRITTEN|WRITTEN/iu.test(source)) return '문어 말뭉치';
  if (/NIKL_SPOKEN|SPOKEN/iu.test(source)) return '구어 말뭉치';
  if (/NIKL_Korean_Dialect|Dialect/iu.test(source)) return '지역어 구술 발화 말뭉치';
  if (/NIKL_OM|온라인 대화/iu.test(source)) return '온라인 대화 말뭉치';
  if (/NIKL_OPM|게시자료/iu.test(source)) return '온라인 게시자료 말뭉치';
  if (/NIKL_CoLA|CoLA/iu.test(source)) return '문법성 판단 말뭉치';
  if (/NIKL_PARAPHRASE|NIKL_PC|PARAPHRASE/iu.test(source)) return '유사 문장 말뭉치';
  if (/NIKL_CF|의미역 기술/iu.test(source)) return '의미역 기술 모형';
  if (/NIKL_DP|NIKL_MP|NIKL_SR|NIKL_ZA|NIKL_SC/iu.test(source)) return '분석 말뭉치';
  if (/Historical Korean Corpus 2024/iu.test(source)) return '역사 말뭉치 2024';
  if (/NIKL_Historical Korean Corpus 2023|Historical Korean Corpus 2023/iu.test(source)) return '역사 말뭉치 2023';
  if (/21세기\s*세종계획|21세기\s*세종계획|sejong/iu.test(source)) return '21세기 세종계획 말뭉치';

  if (typeof input !== 'string' && input.name) return input.name;
  return raw.trim();
}

export function canonicalCorpusKey(input: CorpusLike | string): string {
  const raw = typeof input === 'string' ? input : `${input.name ?? ''} ${input.sourcePath ?? ''}`;
  const normalized = raw.normalize('NFKC').replace(/\\/gu, '/');
  const fileName = normalized.split('/').pop() ?? normalized;

  if (/NIKL_DIALOGUE_2020|DIALOGUE_2020/iu.test(normalized)) return 'nikl-dialogue-2020';
  if (/NIKL_DIALOGUE_2023|DIALOGUE_2023/iu.test(normalized)) return 'nikl-dialogue-2023';
  if (/NIKL_DIALOGUE_2024|DIALOGUE_2024/iu.test(normalized)) return 'nikl-dialogue-2024';
  if (/NIKL_MESSENGER.*JSON|MESSENGER.*JSON/iu.test(normalized)) return 'nikl-messenger-json';
  if (/NIKL_MESSENGER.*CSV|MESSENGER.*CSV/iu.test(normalized)) return 'nikl-messenger-csv';
  if (/NIKL_CI_2023|CI_2023/iu.test(normalized)) return 'nikl-ci-2023';
  if (/NIKL_CI_2024|CI_2024/iu.test(normalized)) return 'nikl-ci-2024';
  if (/NIKL_IU_2023|IU_2023/iu.test(normalized)) return 'nikl-iu-2023';
  if (/NIKLNEWSPAPER_2022|NIKL_NEWSPAPER_2022/iu.test(normalized)) return 'nikl-newspaper-2022';
  if (/NIKL_NEWSPAPER_2020/iu.test(normalized)) return 'nikl-newspaper-2020';
  if (/NIKL_NEWSPAPER_2021/iu.test(normalized)) return 'nikl-newspaper-2021';
  if (/NIKL_NEWSPAPER_2023/iu.test(normalized)) return 'nikl-newspaper-2023';
  if (/NIKL_NEWSPAPER_2024/iu.test(normalized)) return 'nikl-newspaper-2024';
  if (/NIKL_NEWSPAPER(?:_CSV|_v2\.0)|NEWSPAPER(?:_CSV|_v2\.0)/iu.test(normalized)) return 'nikl-newspaper-v2';
  if (/NIKL_WRITTEN/iu.test(normalized)) return 'nikl-written-v1';
  if (/NIKL_SPOKEN/iu.test(normalized)) return 'nikl-spoken-v1';
  if (/NIKL_Korean_Dialect|Dialect/iu.test(normalized)) return 'nikl-dialect-2021';
  if (/NIKL_OM/iu.test(normalized)) return 'nikl-om-2021';
  if (/NIKL_OPM/iu.test(normalized)) return 'nikl-opm-2022';
  if (/NIKL_CoLA|CoLA/iu.test(normalized)) return 'nikl-cola-v1';
  if (/NIKL_PARAPHRASE|NIKL_PC|PARAPHRASE/iu.test(normalized)) return 'nikl-paraphrase-pc';
  if (/NIKL_CF/iu.test(normalized)) return 'nikl-cf-v1';
  if (/NIKL_DP_2024/iu.test(normalized)) return 'nikl-dp-2024';
  if (/NIKL_DP/iu.test(normalized)) return 'nikl-dp-v2';
  if (/NIKL_MP/iu.test(normalized)) return 'nikl-mp-v1';
  if (/NIKL_SR/iu.test(normalized)) return 'nikl-sr-v1';
  if (/NIKL_ZA_2024/iu.test(normalized)) return 'nikl-za-2024';
  if (/NIKL_ZA/iu.test(normalized)) return 'nikl-za-2020';
  if (/NIKL_SC/iu.test(normalized)) return 'nikl-sc-v1';
  if (/Historical Korean Corpus 2024/iu.test(normalized)) return 'nikl-historical-2024';
  if (/NIKL_Historical Korean Corpus 2023|Historical Korean Corpus 2023/iu.test(normalized)) return 'nikl-historical-2023';
  if (/21세기\s*세종계획|21세기\s*세종계획|sejong/iu.test(normalized)) return 'sejong-21c';

  return fileName.replace(/\.[^.]+$/u, '').toLowerCase();
}

export function inferSourceFormatFromMetadata(metadata: Record<string, unknown> | undefined): CorpusSourceFormat {
  const value = typeof metadata?.sourceFormat === 'string' ? metadata.sourceFormat : '';
  if (isKnownSourceFormat(value)) return value;
  return 'unknown';
}

export function inferSourceFormatFromCorpus(input: CorpusLike): CorpusSourceFormat {
  const raw = `${input.name ?? ''} ${input.sourcePath ?? ''}`.normalize('NFKC');
  if (/NIKL_DIALOGUE|DIALOGUE_/iu.test(raw)) return 'nikl-dialogue';
  if (/NIKL_MESSENGER|MESSENGER/iu.test(raw)) return 'nikl-dialogue';
  if (/NIKL_SPOKEN|SPOKEN|NIKL_Korean_Dialect|Dialect|NIKL_OM/iu.test(raw)) return 'nikl-dialogue';
  if (/NIKL_CI_2024|CI_2024/iu.test(raw)) return 'nikl-ci-sentence-json';
  if (/NIKL_CI_2023|CI_2023/iu.test(raw)) return 'nikl-ci-nested-dialogue';
  if (/NIKL_IU_2023|IU_2023/iu.test(raw)) return 'nikl-iu-web';
  if (/NIKL_NEWSPAPER|NIKLNEWSPAPER|NIKL_WRITTEN|NIKL_OPM/iu.test(raw)) return 'nikl-paragraph-json';
  if (/NIKL_DP|NIKL_MP|NIKL_SR|NIKL_ZA|NIKL_SC/iu.test(raw)) return 'nikl-sentence-json';
  if (/NIKL_PARAPHRASE|NIKL_PC|PARAPHRASE/iu.test(raw)) return 'nikl-paraphrase-json';
  if (/NIKL_CoLA|CoLA/iu.test(raw)) return 'nikl-cola-tsv';
  if (/NIKL_CF|의미역 기술/iu.test(raw)) return 'nikl-frame-xml';
  if (/Historical Korean Corpus|역사 말뭉치/iu.test(raw)) return 'nikl-historical-xml';
  if (/21세기\s*세종계획|21세기\s*세종계획|sejong/iu.test(raw)) return 'sejong-tei-text';
  return 'unknown';
}

export function corpusUnitLabel(sourceFormat: CorpusSourceFormat): CorpusUnitLabel {
  return isDialogueSourceFormat(sourceFormat) ? '발화' : '문장';
}

export function isDialogueSourceFormat(sourceFormat: CorpusSourceFormat): boolean {
  return sourceFormat === 'nikl-dialogue' || sourceFormat === 'nikl-ci-nested-dialogue';
}

export function isPseudoSpeaker(speaker: Record<string, unknown> | string | null | undefined): boolean {
  if (typeof speaker === 'string') return speaker.trim().toLowerCase() === 'text';
  const id = String(speaker?.id ?? speaker?.speaker_id ?? '').trim().toLowerCase();
  return id === 'text' || speaker?.pseudo === true;
}

export function sourceFileStem(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/gu, '/');
  return (normalized.split('/').pop() ?? normalized).replace(/\.[^.]+$/u, '');
}

function isKnownSourceFormat(value: string): value is CorpusSourceFormat {
  return (
    value === 'nikl-dialogue' ||
    value === 'nikl-ci-nested-dialogue' ||
    value === 'nikl-ci-sentence-json' ||
    value === 'nikl-iu-web' ||
    value === 'nikl-paragraph-json' ||
    value === 'nikl-sentence-json' ||
    value === 'nikl-paraphrase-json' ||
    value === 'nikl-tabular' ||
    value === 'nikl-cola-tsv' ||
    value === 'nikl-frame-xml' ||
    value === 'nikl-historical-xml' ||
    value === 'sejong-tei-text'
  );
}
