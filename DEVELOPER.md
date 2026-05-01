# Developer Guide

이 문서는 CorpusViewer를 빌드하고 GitHub에 배포하는 개발자용 절차입니다. 일반 사용자는 `README.md`와 Release ZIP만 보면 됩니다.

## 요구 사항

- Node.js 20 이상 권장
- npm
- Windows 배포 ZIP 생성 시 Windows PowerShell

## 개발 실행

```powershell
npm ci
npm run dev
```

## 검증

```powershell
npm run typecheck
npm test
npm run smoke
```

## 배포용 EXE 만들기

```powershell
npm run package
```

패키징 결과:

```text
release/
  win-unpacked/
    CorpusViewer.exe
    corpora/
      여기에_말뭉치_ZIP을_넣으세요.txt
    사용법.txt
  CorpusViewer-v1.0.0-win-x64.zip
```

`npm run package`는 말뭉치 ZIP을 배포물에 복사하지 않습니다. 사용자가 Windows 파일 탐색기로 `corpora` 폴더에 직접 배치하는 흐름을 기본으로 합니다.

## GitHub 업로드

```powershell
git add .
git status --short
git commit -m "Initial CorpusViewer import"
gh repo create <owner>/<repo> --private --source=. --remote=origin --push
```

프로그램 코드는 MIT License로 배포합니다. 말뭉치 원자료와 사용자가 생성한 색인 데이터베이스는 저장소와 배포 ZIP에 포함하지 않습니다.

## 프로젝트 구조

```text
src/main/          Electron main process, SQLite, importer, services
src/preload/       Renderer에 노출되는 안전한 IPC API
src/renderer/      React UI
src/shared/        공용 타입
scripts/           패키징, 스모크 테스트, 벤치마크 보조 스크립트
tests/             Vitest 테스트
corpora/           로컬 말뭉치 배치 폴더, 데이터는 Git 제외
```
