import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface AppPaths {
  portableRoot: string;
  dataDir: string;
  defaultCorporaDir: string;
  tempDir: string;
  databasePath: string;
}

export function getPortableRoot(): string {
  return app.isPackaged ? path.dirname(process.execPath) : process.cwd();
}

export function getAppPaths(): AppPaths {
  const portableRoot = getPortableRoot();
  const dataDir = path.join(portableRoot, 'CorpusViewerData');
  const defaultCorporaDir = path.join(portableRoot, 'corpora');
  const tempDir = path.join(dataDir, 'tmp');
  const databasePath = path.join(dataDir, 'corpusviewer.sqlite');

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(defaultCorporaDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });

  return {
    portableRoot,
    dataDir,
    defaultCorporaDir,
    tempDir,
    databasePath
  };
}
