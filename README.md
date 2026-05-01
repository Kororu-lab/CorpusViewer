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

아래의 말뭉치는 현재 파싱 및 색인이 확인됨.

- `NIKL_DIALOGUE_2023_v1.1.zip`
- `NIKL_DIALOGUE_2024_v1.0.zip`
- `NIKL_MESSENGER_v2.0_JSON.zip`

## 주요 기능

- ZIP, JSON, CSV, 폴더 단위 말뭉치 가져오기 및 재색인
- 일반 텍스트, 정규식, CQL-lite 기반 KWIC 검색
- 검색 결과 CSV 저장
- 빈도, 주제, 범주, 화자, 비언어 표지 통계
- 중심어 주변 공기어 분석
- 말뭉치/범주/주제/문서 단위 탐색
- 발화, 문장, 묶음 단위 보기
- 로컬 불용어 목록 관리

## 검색 예시

```text
진짜
^진짜.*좋다$
[text="진짜"] []{0,3} [text="좋다"]
[pos="NNG"] [text="하다"]
```

CQL-lite는 `[text="..."]`, `[lemma="..."]`, `[pos="..."]` 형태의 토큰 조건과 간격 표현을 지원합니다. `lemma`와 `pos` 검색은 가져온 말뭉치에 제공 토큰 정보가 있을 때 의미가 있습니다.

## 데이터 저장 위치

- `corpora/`: 사용자가 직접 넣는 원본 말뭉치 ZIP
- `CorpusViewerData/corpusviewer.sqlite`: 앱이 자동 생성하는 색인 데이터베이스
- `CorpusViewerData/stopwords.txt`: 불용어 목록
- `CorpusViewerData/tmp/`: 임시 작업 파일

`CorpusViewerData`를 삭제하면 색인 재생성 필요. 원본 말뭉치 ZIP의 배포 가능 여부는 원자료 제공처의 라이선스를 따름.

## 라이선스

CorpusViewer 프로그램 코드는 [MIT License](LICENSE)로 배포합니다.

말뭉치 원자료, 사용자가 직접 넣는 ZIP/JSON/CSV 데이터, 원자료에서 생성한 색인 데이터베이스는 이 저장소에 포함되지 않으며 MIT License 적용 대상이 아님. 해당 데이터의 사용, 보관, 재배포 책임은 원자료 제공처의 라이선스와 사용자의 이용 조건을 따름.

## 저장소에 포함하지 않는 파일

- `corpora/` 아래의 로컬 말뭉치 파일
- 루트의 `NIKL_*.zip`
- `_corpus_unzipped/`
- `CorpusViewerData/`
- `*.sqlite`, `*.db` 및 관련 저널 파일
- `out/`, `dist/`, `release/`, `node_modules/`

개발과 배포 절차는 [DEVELOPER.md](DEVELOPER.md)를 참고
