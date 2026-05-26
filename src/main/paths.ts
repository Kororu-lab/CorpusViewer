import { app } from 'electron';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
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
  const legacyDataDir = path.join(portableRoot, 'GovCorpusData');
  const defaultCorporaDir = path.join(portableRoot, 'corpora');
  const tempDir = path.join(dataDir, 'tmp');
  const databasePath = path.join(dataDir, 'corpusviewer.sqlite');
  const legacyDatabasePath = path.join(dataDir, 'govcorpus.sqlite');
  const legacyDataCorpusViewerDatabasePath = path.join(legacyDataDir, 'corpusviewer.sqlite');
  const legacyDataGovCorpusDatabasePath = path.join(legacyDataDir, 'govcorpus.sqlite');

  if (!existsSync(dataDir) && existsSync(legacyDataDir)) {
    renameSync(legacyDataDir, dataDir);
  }

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(defaultCorporaDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });

  if (!existsSync(databasePath) && existsSync(legacyDatabasePath)) {
    moveDatabaseFiles(legacyDatabasePath, databasePath);
  }

  if (!existsSync(databasePath) && existsSync(legacyDataCorpusViewerDatabasePath)) {
    moveDatabaseFiles(legacyDataCorpusViewerDatabasePath, databasePath);
  }

  if (!existsSync(databasePath) && existsSync(legacyDataGovCorpusDatabasePath)) {
    moveDatabaseFiles(legacyDataGovCorpusDatabasePath, databasePath);
  }

  return {
    portableRoot,
    dataDir,
    defaultCorporaDir,
    tempDir,
    databasePath
  };
}

function moveDatabaseFiles(sourceDatabasePath: string, targetDatabasePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${sourceDatabasePath}${suffix}`;
    const target = `${targetDatabasePath}${suffix}`;
    if (existsSync(source) && !existsSync(target)) {
      renameSync(source, target);
    }
  }
}
