import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const releaseRoot = path.join(root, 'release');
const portableRoot = path.join(releaseRoot, 'win-unpacked');
const corporaDir = path.join(portableRoot, 'corpora');
const dataDirs = ['CorpusViewerData', 'GovCorpusData'].map((name) => path.join(portableRoot, name));
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
const archivePath = path.join(releaseRoot, `CorpusViewer-v${version}-win-x64.zip`);

if (!existsSync(portableRoot)) {
  throw new Error(`Portable folder does not exist: ${portableRoot}`);
}

function assertInsidePortable(targetPath) {
  const resolvedPortableRoot = path.resolve(portableRoot);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedPortableRoot && !resolvedTarget.startsWith(`${resolvedPortableRoot}${path.sep}`)) {
    throw new Error(`Refusing to touch path outside portable folder: ${targetPath}`);
  }
}

for (const dataDir of dataDirs) {
  if (!existsSync(dataDir)) continue;
  const entries = readdirSync(dataDir);
  if (entries.length > 0) {
    throw new Error(`Refusing to package runtime data. Run npm run package so runtime data is backed up before archiving: ${dataDir}`);
  }
  assertInsidePortable(dataDir);
  rmSync(dataDir, { recursive: true, force: true });
}

assertInsidePortable(corporaDir);
rmSync(corporaDir, { recursive: true, force: true });
mkdirSync(corporaDir, { recursive: true });

writeFileSync(
  path.join(corporaDir, '여기에_말뭉치_ZIP을_넣으세요.txt'),
  [
    '이 폴더에 NIKL 말뭉치 ZIP 파일을 복사하세요.',
    '',
    '1. Windows 파일 탐색기로 이 corpora 폴더를 엽니다.',
    '2. NIKL_*.zip 파일을 이 폴더에 복사합니다.',
    '3. CorpusViewer.exe를 실행합니다.',
    '4. 앱의 말뭉치 화면에서 "corpora 폴더 가져오기"를 누릅니다.',
    ''
  ].join('\n'),
  'utf8'
);

writeFileSync(
  path.join(portableRoot, '사용법.txt'),
  [
    'CorpusViewer 사용법',
    '',
    '1. 이 ZIP 파일을 원하는 위치에 압축 해제합니다.',
    '2. CorpusViewer.exe 옆의 corpora 폴더에 말뭉치 ZIP 파일을 복사합니다.',
    '3. CorpusViewer.exe를 더블클릭합니다.',
    '4. 왼쪽의 "말뭉치" 화면에서 "corpora 폴더 가져오기"를 누릅니다.',
    '5. 색인이 끝나면 검색, 통계, 공기어, 탐색 화면을 사용합니다.',
    '',
    '데이터 위치',
    '- corpora: 사용자가 넣는 원본 말뭉치 ZIP',
    '- CorpusViewerData: 앱이 자동으로 만드는 색인 데이터베이스와 불용어 파일',
    '',
    '주의',
    '- CorpusViewerData 폴더를 삭제하면 색인을 다시 만들어야 합니다.',
    '- 말뭉치 원자료의 배포 가능 여부는 원자료 제공처의 라이선스를 따릅니다.',
    ''
  ].join('\n'),
  'utf8'
);

if (process.platform !== 'win32') {
  console.log(`Prepared portable folder at ${portableRoot}`);
  console.log('Skipping ZIP archive creation because this packaging helper expects Windows PowerShell.');
  process.exit(0);
}

rmSync(archivePath, { force: true });

const result = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    '$ErrorActionPreference = "Stop"; $source = Join-Path -Path $env:CORPUSVIEWER_PORTABLE_ROOT -ChildPath "*"; Compress-Archive -Path $source -DestinationPath $env:CORPUSVIEWER_ARCHIVE_PATH -CompressionLevel Optimal'
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      CORPUSVIEWER_PORTABLE_ROOT: portableRoot,
      CORPUSVIEWER_ARCHIVE_PATH: archivePath
    }
  }
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Compress-Archive failed with exit code ${result.status ?? 'unknown'}`);
}

console.log(`Prepared portable folder at ${portableRoot}`);
console.log(`Created ${archivePath}`);
