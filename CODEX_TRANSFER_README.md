# CorpusViewer Standard Codex Transfer

이 ZIP은 다른 Windows의 Codex에서 현재 작업을 이어가기 위한 전달본이다.

## 포함

- 현재 작업 트리의 소스, 테스트, 패키징 스크립트
- `CODEX_TRANSFER_README.md`
- `codex-session/sessions/.../*.jsonl` 아래의 현재 Codex 대화 세션 파일

## 제외

- `.git/`
- `node_modules/`
- `release/`, `out/`, `dist/`
- 런타임 DB: `CorpusViewerData/`, `GovCorpusData/`, `*.sqlite`, `*.db`
- 대형 corpus/archive 자료: `new/`, `corpora/*.zip`, `*.zip`, `_corpus_unzipped/`, `코퍼스/`

## 다른 Windows에서 이어가기

1. ZIP을 원하는 작업 폴더에 푼다.
2. Codex에서 압축 해제한 폴더를 연다.
3. 대화 세션까지 복원하려면 ZIP 내부의 `codex-session/sessions/2026/05/13/*.jsonl`을 새 PC의 `%USERPROFILE%\.codex\sessions\2026\05\13\`로 복사한다.
4. 의존성이 필요하면 Node.js 설치 후 `npm install`을 실행한다.
5. corpus ZIP과 기존 런타임 DB는 별도 보관본에서 다시 배치한다.

## 현재 주요 상태

- 제품명: `CorpusViewer Standard`
- 주요 작업: 신규 말뭉치 호환, 세종계획 importer, Git tmp_pack garbage 자동 청소, 세종계획 metadata 중복 저장 축소
- 패키지 스크립트는 실행 전 `scripts/cleanup-git-garbage.mjs`를 호출한다.
