import { describe, expect, it } from 'vitest';
import { mergeSentenceGroupsIntoBundles, mergeUtterancesIntoBundles, mergeUtterancesIntoSentences } from '../src/renderer/src/sentenceMerge';
import type { DocumentDetail } from '../src/shared/types';

type Utterance = DocumentDetail['utterances'][number];

function utterance(sequence: number, form: string, speakerId = 'S1'): Utterance {
  return {
    utteranceId: `U${sequence}`,
    speakerId,
    sequence,
    form,
    originalForm: form,
    time: `${sequence}.00s`,
    start: sequence,
    end: sequence + 1,
    note: null
  };
}

describe('mergeUtterancesIntoSentences', () => {
  it('does not split inside a single utterance with expressive punctuation and reactions', () => {
    const groups = mergeUtterancesIntoSentences([utterance(1, '김치만두에 김치 안 밍밍하고 살짝 매웠는 데!?? ㅠㅠ')]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      startSequence: 1,
      endSequence: 1,
      utteranceCount: 1,
      text: '김치만두에 김치 안 밍밍하고 살짝 매웠는 데!?? ㅠㅠ'
    });
  });

  it('does not insert separators or split malformed trailing text', () => {
    const text = '그나저나 나 끼리 아이스크림 좀 먹고싶다 ㅠ 그거 왜 안팔지?ㅔ';
    const groups = mergeUtterancesIntoSentences([utterance(1, text)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].text).toBe(text);
  });

  it('merges consecutive same-speaker utterances until terminal punctuation', () => {
    const groups = mergeUtterancesIntoSentences([utterance(1, 'A'), utterance(2, 'B'), utterance(3, 'C.')]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      startSequence: 1,
      endSequence: 3,
      utteranceCount: 3,
      text: 'A B C.'
    });
  });

  it('attaches short reaction utterances to the previous same-speaker sentence', () => {
    const groups = mergeUtterancesIntoSentences([utterance(1, '사오길 잘한 거 같아!'), utterance(2, '!'), utterance(3, 'ㅋㅋㅋ')]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      startSequence: 1,
      endSequence: 3,
      utteranceCount: 3,
      text: '사오길 잘한 거 같아!! ㅋㅋㅋ'
    });
  });

  it('does not merge across speaker changes', () => {
    const groups = mergeUtterancesIntoSentences([utterance(1, '아직 끝나지 않은 말', 'A'), utterance(2, '다른 화자의 말입니다.', 'B')]);

    expect(groups).toHaveLength(2);
    expect(groups[0].text).toBe('아직 끝나지 않은 말');
    expect(groups[1].text).toBe('다른 화자의 말입니다.');
  });

  it('keeps slash text intact in conservative sentence mode', () => {
    const text = '운동을 집앞으로 다니는데도/가기싫어서 무거운 발 이끌고/가는데';
    const groups = mergeUtterancesIntoSentences([utterance(1, text)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].text).toBe(text);
  });
});

describe('mergeUtterancesIntoBundles', () => {
  it('bundles short consecutive same-speaker sentences more aggressively', () => {
    const groups = mergeUtterancesIntoBundles([
      utterance(1, '루비 사료 샀어?'),
      utterance(2, '아니 아직 못샀어 뭐 사야돼?')
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      startSequence: 1,
      endSequence: 2,
      utteranceCount: 2,
      sentenceCount: 2,
      text: '루비 사료 샀어? 아니 아직 못샀어 뭐 사야돼?'
    });
  });

  it('bundles short fragments from the same speaker', () => {
    const groups = mergeUtterancesIntoBundles([utterance(5, '양고기 맛'), utterance(6, '양고기?')]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      startSequence: 5,
      endSequence: 6,
      utteranceCount: 2,
      sentenceCount: 1,
      text: '양고기 맛 양고기?'
    });
  });

  it('does not bundle across speaker changes', () => {
    const groups = mergeUtterancesIntoBundles([utterance(1, '루비 사료 샀어?', 'A'), utterance(2, '아니 아직 못샀어 뭐 사야돼?', 'B')]);

    expect(groups).toHaveLength(2);
    expect(groups[0].text).toBe('루비 사료 샀어?');
    expect(groups[1].text).toBe('아니 아직 못샀어 뭐 사야돼?');
  });

  it('does not bundle long candidates or bundles over 180 characters', () => {
    const longText = '이 문장은 이미 충분히 길어서 탐색 묶음 모드에서도 다른 짧은 문장과 강제로 붙이지 않는다.';
    const overLimitGroups = mergeUtterancesIntoBundles([
      utterance(1, longText),
      utterance(2, '짧은 후속 문장?')
    ]);

    expect(overLimitGroups).toHaveLength(2);
    expect(overLimitGroups[0].text).toBe(longText);

    const manyShortGroups = mergeSentenceGroupsIntoBundles(
      Array.from({ length: 7 }, (_, index) => mergeUtterancesIntoSentences([utterance(index + 1, `${index + 1}?`)])[0])
    );
    expect(manyShortGroups).toHaveLength(2);
    expect(manyShortGroups[0].utteranceCount).toBe(6);
    expect(manyShortGroups[1].utteranceCount).toBe(1);
  });

  it('leaves original utterance rows untouched for utterance mode round trips', () => {
    const utterances = [utterance(1, 'A'), utterance(2, 'B.'), utterance(3, 'C?')];
    const originalRows = utterances.map((row) => `${row.sequence}:${row.form}`);

    mergeUtterancesIntoSentences(utterances);
    mergeUtterancesIntoBundles(utterances);
    mergeUtterancesIntoSentences(utterances);

    expect(utterances.map((row) => `${row.sequence}:${row.form}`)).toEqual(originalRows);
  });
});
