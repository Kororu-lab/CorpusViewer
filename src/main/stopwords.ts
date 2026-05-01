import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StopwordSettings } from '@shared/types';
import type { AppPaths } from './paths';

function stopwordPath(paths: AppPaths): string {
  return path.join(paths.dataDir, 'stopwords.txt');
}

function parseStopwords(text: string): string[] {
  return Array.from(new Set(text.split(/[,\s]+/u).map((item) => item.trim()).filter(Boolean)));
}

export function readStopwords(paths: AppPaths): StopwordSettings {
  const filePath = stopwordPath(paths);
  if (!existsSync(filePath)) writeFileSync(filePath, '', 'utf8');
  const text = readFileSync(filePath, 'utf8');
  return {
    path: filePath,
    text,
    words: parseStopwords(text)
  };
}

export function writeStopwords(paths: AppPaths, text: string): StopwordSettings {
  const filePath = stopwordPath(paths);
  writeFileSync(filePath, text, 'utf8');
  return {
    path: filePath,
    text,
    words: parseStopwords(text)
  };
}
