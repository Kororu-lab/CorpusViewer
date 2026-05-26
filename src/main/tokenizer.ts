import { normalizeLegacyHangulText } from '../shared/textNormalization';

export interface NormalizedToken {
  surface: string;
  normalized: string;
}

const MARKER_PATTERN = /^\{[^\}]+\}$/u;

export function normalizeToken(surface: string): string {
  const trimmed = normalizeLegacyHangulText(surface).trim();
  if (!trimmed) return '';
  if (MARKER_PATTERN.test(trimmed)) return trimmed.toLowerCase();

  const stripped = trimmed
    .replace(/^[\p{P}\p{S}\s]+/gu, '')
    .replace(/[\p{P}\p{S}\s]+$/gu, '')
    .toLowerCase();

  return stripped || trimmed.toLowerCase();
}

export function tokenizeText(text: string): NormalizedToken[] {
  return text
    .split(/\s+/u)
    .map((surface) => ({ surface, normalized: normalizeToken(surface) }))
    .filter((token) => token.surface && token.normalized);
}

export function isNonSpeechMarker(text: string): boolean {
  return MARKER_PATTERN.test(text.trim());
}
