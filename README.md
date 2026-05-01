# CorpusViewer

![Version](https://img.shields.io/badge/version-v1.0-blue)

지정된 말뭉치를 Windows에서 바로 색인하고 검색하는 데스크톱 프로그램.

## 설치와 실행

1. GitHub Releases에서 `CorpusViewer-v1.0.0-win-x64.zip`을 다운로드
2. Windows 파일 탐색기에서 ZIP 압축 해제
3. 압축을 푼 폴더에서 `CorpusViewer.exe`를 실행

## 말뭉치 ZIP 넣기

1. `CorpusViewer.exe`가 있는 폴더 안의 `corpora` 폴더 열기
2. 보유한 말뭉치 ZIP 파일을 `corpora` 폴더에 복사
3. `CorpusViewer.exe`를 실행
4. 왼쪽의 “말뭉치” 화면에서 “corpora 폴더 가져오기” 클릭
5. 색인이 끝나면 검색, 통계, 공기어, 탐색 기능을 사용 가능

앱 안의 “말뭉치 폴더 열기” 버튼을 누르면 Windows 파일 탐색기로 `corpora` 폴더가 열리도록 구성되어 있음.

## 배포 폴더 구조

```text
CorpusViewer-v1.0.0-win-x64/
  CorpusViewer.exe
  corpora/
    여기에_말뭉치_ZIP을_넣으세요.txt
  CorpusViewerData/        앱 실행 중 자동 생성
  사용법.txt
  기타 실행에 필요한 파일들
```

## 지원 말뭉치

아래 항목은 국립국어원 [모두의 말뭉치](https://kli.korean.go.kr/corpus/main/requestMain.do) 공식 목록과 대조하고, 현재 파싱 및 색인이 확인됨. 지속적으로 추가할 예정.

| 말뭉치 | 공식 버전 | 확인한 파일명 | 지원 상태 | 공식 URL |
| --- | --- | --- | --- | --- |
| 일상 대화 말뭉치 2023 | 1.1 | `NIKL_DIALOGUE_2023_v1.1.zip` | 지원, 파싱/색인 확인 | [모두의 말뭉치 검색](https://kli.korean.go.kr/corpus/main/requestMain.do?tabType=thumb&lang=ko&keyword=%EC%9D%BC%EC%83%81%20%EB%8C%80%ED%99%94%20%EB%A7%90%EB%AD%89%EC%B9%98%202023) |
| 일상 대화 말뭉치 2024 | 1.0 | `NIKL_DIALOGUE_2024_v1.0.zip` | 지원, 파싱/색인 확인 | [모두의 말뭉치 검색](https://kli.korean.go.kr/corpus/main/requestMain.do?tabType=thumb&lang=ko&keyword=%EC%9D%BC%EC%83%81%20%EB%8C%80%ED%99%94%20%EB%A7%90%EB%AD%89%EC%B9%98%202024) |
| 메신저 말뭉치 | 2.0 | `NIKL_MESSENGER_v2.0_JSON.zip` | 지원, 파싱/색인 확인 | [모두의 말뭉치 검색](https://kli.korean.go.kr/corpus/main/requestMain.do?tabType=thumb&lang=ko&keyword=%EB%A9%94%EC%8B%A0%EC%A0%80%20%EB%A7%90%EB%AD%89%EC%B9%98) |

## 주요 기능

- ZIP, JSON, CSV, 폴더 단위 말뭉치 가져오기 및 재색인
- 일반 텍스트, 정규식, CQL-lite 기반 KWIC 검색
- 검색 결과 CSV 저장
- 빈도, 주제, 범주, 화자, 비언어 표지 통계
- 중심어 주변 공기어 분석
- 말뭉치/범주/주제/문서 단위 탐색
- 발화, 문장, 묶음 단위 보기
- 로컬 불용어 목록 관리

## 검색 문법

검색 모드는 `부분 문자열`, `정규식`, `CQL-lite` 세 가지.

| 모드 | 입력 예시 | 동작 |
| --- | --- | --- |
| 부분 문자열 | `진짜` | 정규화 발화 또는 원문 발화에서 문자열 검색. 1~2글자 부분 문자열은 전체 스캔 방지를 위해 제한. 정확한 짧은 토큰은 CQL-lite 권장 |
| 정규식 | `^진짜.*좋다$` | JavaScript 정규식 문법. 플래그는 내부적으로 `u` 사용. 정규화 발화/원문 발화 선택 가능 |
| CQL-lite | `[text="진짜"] []{0,3} [text="좋다"]` | 토큰 단위 검색. 단어 간 거리, 표제어, 품사 조건 지원 |

### 부분 문자열

- 검색 대상: `정규화 발화` 또는 `원문 발화`
- 3글자 이상 문자열은 SQLite FTS 기반 검색
- 색인된 토큰과 정확히 일치하는 짧은 검색어는 토큰 색인으로 검색
- 1~2글자 임의 부분 문자열은 비활성화. 예: `가`, `좋`

### 정규식

- JavaScript `RegExp` 패턴 입력. 예: `진짜.*좋`, `^아니`, `(진짜|정말)`
- 별도 `/.../g` 표기 없이 패턴 본문만 입력
- 내부 플래그: `u`
- 검색 대상: `정규화 발화` 또는 `원문 발화`
- 첫 화면 검색은 최대 250,000개 발화까지 스캔. 더 좁은 결과는 말뭉치/연도/범주/주제/화자 필터 활용
- 전체 결과 CSV 저장 시 전체 검색으로 내보내기 수행

### CQL-lite

토큰 조건 형식:

```text
[text="진짜"]
[lemma="하다"]
[pos="NNG"]
```

지원 필드:

| 필드 | 의미 |
| --- | --- |
| `text` | 정규화된 토큰 표면형 |
| `lemma` | 말뭉치가 제공한 표제어 |
| `pos` | 말뭉치가 제공한 품사 |

지원 연산자:

| 연산자 | 의미 | 예시 |
| --- | --- | --- |
| `=` | 정확히 일치 | `[text="좋다"]` |
| `~` | 정규식 일치 | `[pos~"^N"]` |

거리와 반복:

```text
[]              # 토큰 1개
[]{0,3}         # 토큰 0~3개
[text="정말"]{1,2}
```

자주 쓰는 예:

```text
[text="진짜"] []{0,3} [text="좋다"]
[pos="NNG"] [text="하다"]
[lemma="먹다"]
[pos~"^V"] []{0,2} [text="요"]
```

`lemma`, `pos` 검색은 가져온 말뭉치에 제공 토큰 정보가 있을 때만 의미 있음. 필터의 토큰 소스를 `제공 POS`로 선택하거나, CQL 조건에 `lemma`/`pos`가 있으면 제공 토큰 기준으로 처리.

## 데이터 저장 위치

- `corpora/`: 사용자가 직접 넣는 원본 말뭉치 ZIP
- `CorpusViewerData/corpusviewer.sqlite`: 앱이 자동 생성하는 색인 데이터베이스
- `CorpusViewerData/stopwords.txt`: 불용어 목록
- `CorpusViewerData/tmp/`: 임시 작업 파일

`CorpusViewerData`를 삭제하면 색인 재생성 필요. 원본 말뭉치 ZIP의 배포 가능 여부는 원자료 제공처의 라이선스를 따름.

## 라이선스

CorpusViewer 프로그램 코드는 [MIT License](LICENSE)로 배포됨.

말뭉치 원자료, 사용자가 직접 넣는 ZIP/JSON/CSV 데이터, 원자료에서 생성한 색인 데이터베이스는 이 저장소에 포함되지 않으며 MIT License 적용 대상이 아님. 해당 데이터의 사용, 보관, 재배포 책임은 원자료 제공처의 라이선스와 사용자의 이용 조건을 따름.

## 저장소에 포함하지 않는 파일

- `corpora/` 아래의 로컬 말뭉치 파일
- 루트의 `NIKL_*.zip`
- `_corpus_unzipped/`
- `CorpusViewerData/`
- `*.sqlite`, `*.db` 및 관련 저널 파일
- `out/`, `dist/`, `release/`, `node_modules/`

개발과 배포 절차는 [DEVELOPER.md](DEVELOPER.md)를 참고
