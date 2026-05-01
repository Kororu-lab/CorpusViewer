import { describe, expect, it } from 'vitest';
import { isNonSpeechMarker, normalizeToken, tokenizeText } from '../src/main/tokenizer';

describe('tokenizer', () => {
  it('normalizes Korean tokens with edge punctuation', () => {
    expect(normalizeToken('좋아요.')).toBe('좋아요');
    expect(normalizeToken('"먹다"')).toBe('먹다');
  });

  it('keeps non-speech markers searchable', () => {
    expect(normalizeToken('{emoji}')).toBe('{emoji}');
    expect(isNonSpeechMarker('{laughing}')).toBe(true);
  });

  it('tokenizes whitespace-delimited corpus text', () => {
    expect(tokenizeText('진짜 너무 좋아요.').map((token) => token.normalized)).toEqual(['진짜', '너무', '좋아요']);
  });
});
