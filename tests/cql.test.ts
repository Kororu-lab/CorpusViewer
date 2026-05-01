import { describe, expect, it } from 'vitest';
import { matchCql, parseCql } from '../src/main/cql';

describe('CQL-lite parser', () => {
  it('parses exact, wildcard range, and exact sequence', () => {
    const parsed = parseCql('[text="진짜"] []{0,3} [text="좋다"]');
    expect(parsed).toHaveLength(3);
    expect(parsed[1]).toMatchObject({ min: 0, max: 3 });
  });

  it('matches token distance patterns', () => {
    const elements = parseCql('[text="진짜"] []{0,3} [text="좋다"]');
    const matches = matchCql(elements, [
      { surface: '아', normalized: '아' },
      { surface: '진짜', normalized: '진짜' },
      { surface: '너무', normalized: '너무' },
      { surface: '좋다', normalized: '좋다' }
    ]);
    expect(matches).toEqual([{ start: 1, end: 4 }]);
  });

  it('supports future POS tokens', () => {
    const elements = parseCql('[pos="VV"]');
    const matches = matchCql(elements, [
      { surface: '먹고', normalized: '먹고', lemma: '먹다', pos: 'VV' },
      { surface: '싶다', normalized: '싶다', lemma: '싶다', pos: 'VX' }
    ]);
    expect(matches).toEqual([{ start: 0, end: 1 }]);
  });
});
