import * as hypuaUnicoderModule from 'hypua-unicoder';

const HANYANG_PUA_PATTERN = /[\ue000-\uf8ff]/u;
type HanyangPuaConverter = (text: string, options?: { htmlEscape?: boolean }) => string;
const hanyangPuaToUnicode = resolveHanyangPuaConverter(hypuaUnicoderModule);

export function normalizeLegacyHangulText(value: string): string {
  if (!HANYANG_PUA_PATTERN.test(value)) return value;
  return hanyangPuaToUnicode(value);
}

function resolveHanyangPuaConverter(moduleValue: unknown): HanyangPuaConverter {
  if (typeof moduleValue === 'function') return moduleValue as HanyangPuaConverter;

  const defaultExport = (moduleValue as { default?: unknown }).default;
  if (typeof defaultExport === 'function') return defaultExport as HanyangPuaConverter;

  const nestedDefault = (defaultExport as { default?: unknown } | undefined)?.default;
  if (typeof nestedDefault === 'function') return nestedDefault as HanyangPuaConverter;

  throw new TypeError('hypua-unicoder converter function was not found.');
}
