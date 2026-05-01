import { describe, expect, it } from 'vitest';
import { splitDisplaySegments } from '../src/renderer/src/textSegments';

describe('splitDisplaySegments', () => {
  it('splits conversational slash and laughter boundaries', () => {
    const text =
      '운동을 집앞으로 다니는데도/가기싫어서 무거운 발 이끌고/가는데/하고나면 엄청 개운해여ㅋㅋㅋㅋ//사람마다 케바케 인데/저는 좋았어욤ㅋㅋ//라인도 잡히고/속근육도 만들고';

    expect(splitDisplaySegments(text)).toEqual([
      '운동을 집앞으로 다니는데도',
      '가기싫어서 무거운 발 이끌고',
      '가는데',
      '하고나면 엄청 개운해여ㅋㅋㅋㅋ',
      '사람마다 케바케 인데',
      '저는 좋았어욤ㅋㅋ',
      '라인도 잡히고',
      '속근육도 만들고'
    ]);
  });

  it('does not split URLs or numeric slash values', () => {
    expect(splitDisplaySegments('http://example.com/a 2024/05/01 3/4 좋아요')).toEqual([
      'http://example.com/a 2024/05/01 3/4 좋아요'
    ]);
  });

  it('keeps punctuation and reaction runs with the same sentence', () => {
    expect(splitDisplaySegments('사오길 잘한 거 같아!!ㅋㅋㅋ')).toEqual(['사오길 잘한 거 같아!!ㅋㅋㅋ']);
    expect(splitDisplaySegments('살짝 매웠는 데!? ㅠㅠ')).toEqual(['살짝 매웠는 데!? ㅠㅠ']);
  });
});
