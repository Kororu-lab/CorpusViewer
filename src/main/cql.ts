import { normalizeToken } from './tokenizer';

export type CqlOperator = '=' | '~';
export type CqlField = 'text' | 'lemma' | 'pos';

export interface CqlElement {
  field?: CqlField;
  op?: CqlOperator;
  value?: string;
  min: number;
  max: number;
}

export interface SearchToken {
  normalized: string;
  surface: string;
  lemma?: string | null;
  pos?: string | null;
}

export interface CqlMatch {
  start: number;
  end: number;
}

const ELEMENT_PATTERN = /\[([^\]]*)\](?:\{(\d+)(?:,(\d+))?\})?/gu;
const ATTR_PATTERN = /^\s*(text|lemma|pos)\s*(=|~)\s*"((?:\\"|[^"])*)"\s*$/u;

export function parseCql(query: string): CqlElement[] {
  const elements: CqlElement[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = ELEMENT_PATTERN.exec(query)) !== null) {
    const between = query.slice(cursor, match.index).trim();
    if (between) {
      throw new Error(`지원하지 않는 CQL 구문입니다: ${between}`);
    }

    const body = match[1].trim();
    const min = Number(match[2] ?? 1);
    const max = Number(match[3] ?? match[2] ?? 1);
    if (max < min) {
      throw new Error('반복 범위의 최댓값은 최솟값보다 작을 수 없습니다.');
    }

    if (!body) {
      elements.push({ min, max });
    } else {
      const attr = ATTR_PATTERN.exec(body);
      if (!attr) {
        throw new Error(`지원하지 않는 CQL 조건입니다: [${body}]`);
      }
      const [, field, op, rawValue] = attr;
      const value = rawValue.replace(/\\"/gu, '"');
      elements.push({
        field: field as CqlField,
        op: op as CqlOperator,
        value,
        min,
        max
      });
    }

    cursor = ELEMENT_PATTERN.lastIndex;
  }

  if (elements.length === 0 || query.slice(cursor).trim()) {
    throw new Error('CQL은 [text="..."] 형식의 토큰 조건으로 작성해야 합니다.');
  }

  return elements;
}

export function findAnchor(elements: CqlElement[]): CqlElement | undefined {
  return elements.find((element) => element.field && element.op === '=' && element.value);
}

export function cqlElementMatches(element: CqlElement, token: SearchToken): boolean {
  if (!element.field) return true;
  const value = element.value ?? '';
  const target = getTokenField(element.field, token);

  if (element.op === '=') {
    const normalizedValue = element.field === 'text' ? normalizeToken(value) : value;
    return target === normalizedValue;
  }

  try {
    return new RegExp(value, 'u').test(target);
  } catch {
    throw new Error(`정규식이 올바르지 않습니다: ${value}`);
  }
}

export function matchCql(elements: CqlElement[], tokens: SearchToken[]): CqlMatch[] {
  const matches: CqlMatch[] = [];

  const walk = (elementIndex: number, tokenIndex: number, start: number): void => {
    if (elementIndex >= elements.length) {
      matches.push({ start, end: tokenIndex });
      return;
    }

    const element = elements[elementIndex];
    for (let count = element.min; count <= element.max; count += 1) {
      if (tokenIndex + count > tokens.length) continue;
      let ok = true;
      for (let offset = 0; offset < count; offset += 1) {
        if (!cqlElementMatches(element, tokens[tokenIndex + offset])) {
          ok = false;
          break;
        }
      }
      if (ok) {
        walk(elementIndex + 1, tokenIndex + count, start);
      }
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    walk(0, i, i);
  }

  return matches;
}

function getTokenField(field: CqlField, token: SearchToken): string {
  if (field === 'text') return token.normalized || normalizeToken(token.surface);
  if (field === 'lemma') return token.lemma ?? '';
  return token.pos ?? '';
}
