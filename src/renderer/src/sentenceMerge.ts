import type { DocumentDetail } from '@shared/types';

type ExploreUtterance = DocumentDetail['utterances'][number];

export interface ExploreSentenceGroup {
  id: string;
  speakerId: string;
  startSequence: number;
  endSequence: number;
  text: string;
  timeLabel: string;
  utteranceCount: number;
  sentenceCount?: number;
}

interface WorkingSentenceGroup {
  speakerId: string;
  startSequence: number;
  endSequence: number;
  startTimeLabel: string;
  endTimeLabel: string;
  parts: string[];
  utteranceIds: string[];
}

function textForUtterance(utterance: ExploreUtterance): string {
  return (utterance.form || utterance.originalForm || '').trim();
}

function timeLabelForUtterance(utterance: ExploreUtterance): string {
  if (utterance.time) return utterance.time;
  if (utterance.start !== null && utterance.start !== undefined && utterance.end !== null && utterance.end !== undefined) {
    return `${utterance.start.toFixed(2)}-${utterance.end.toFixed(2)}s`;
  }
  if (utterance.start !== null && utterance.start !== undefined) return `${utterance.start.toFixed(2)}s`;
  return '';
}

function hasTerminalPunctuation(text: string): boolean {
  return /[.!?\u3002\uff1f\uff01]+(?:\s*[\u314b\u314e\u315c\u3160]+)?["')\]}\u201d\u2019]*$/u.test(text.trim());
}

function isShortReaction(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && /^[.!?\u3002\uff1f\uff01\u314b\u314e\u315c\u3160\s]+$/u.test(trimmed);
}

function joinParts(parts: string[]): string {
  return parts.join(' ').replace(/\s+/gu, ' ').trim();
}

function appendText(base: string, addition: string): string {
  const right = addition.trim();
  if (!base) return right;
  if (!right) return base;
  if (/^[.!?\u3002\uff1f\uff01]+[\u314b\u314e\u315c\u3160]*$/u.test(right)) return `${base}${right}`;
  return `${base} ${right}`;
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function isShortBundleCandidate(group: ExploreSentenceGroup): boolean {
  const normalized = normalizeInlineText(group.text);
  if (!normalized) return false;
  const wordCount = normalized.split(/\s+/u).filter(Boolean).length;
  return normalized.length <= 35 || wordCount <= 7;
}

function canAppendBundleGroup(bundle: ExploreSentenceGroup[], group: ExploreSentenceGroup): boolean {
  if (bundle.length === 0) return true;
  const first = bundle[0];
  if (first.speakerId !== group.speakerId) return false;
  const utteranceCount = bundle.reduce((sum, item) => sum + item.utteranceCount, 0) + group.utteranceCount;
  if (utteranceCount > 6) return false;
  const textLength = normalizeInlineText([...bundle.map((item) => item.text), group.text].join(' ')).length;
  return textLength <= 180;
}

function combineTimeLabels(first: string, last: string): string {
  if (first && last && first !== last) return `${first} - ${last}`;
  return first || last;
}

function toBundleGroup(bundle: ExploreSentenceGroup[]): ExploreSentenceGroup | null {
  if (bundle.length === 0) return null;
  if (bundle.length === 1) {
    return {
      ...bundle[0],
      sentenceCount: bundle[0].sentenceCount ?? 1
    };
  }
  const first = bundle[0];
  const last = bundle[bundle.length - 1];
  return {
    id: `bundle:${bundle.map((group) => group.id).join('|')}`,
    speakerId: first.speakerId,
    startSequence: first.startSequence,
    endSequence: last.endSequence,
    text: normalizeInlineText(bundle.map((group) => group.text).join(' ')),
    timeLabel: combineTimeLabels(first.timeLabel, last.timeLabel),
    utteranceCount: bundle.reduce((sum, group) => sum + group.utteranceCount, 0),
    sentenceCount: bundle.reduce((sum, group) => sum + (group.sentenceCount ?? 1), 0)
  };
}

function toSentenceGroup(group: WorkingSentenceGroup): ExploreSentenceGroup {
  const sequenceRange = group.startSequence === group.endSequence ? String(group.startSequence) : `${group.startSequence}-${group.endSequence}`;
  const timeLabel =
    group.startTimeLabel && group.endTimeLabel && group.startTimeLabel !== group.endTimeLabel
      ? `${group.startTimeLabel} - ${group.endTimeLabel}`
      : group.startTimeLabel || group.endTimeLabel;
  return {
    id: `${group.speakerId}:${sequenceRange}:${group.utteranceIds.join('|')}`,
    speakerId: group.speakerId,
    startSequence: group.startSequence,
    endSequence: group.endSequence,
    text: joinParts(group.parts),
    timeLabel,
    utteranceCount: group.utteranceIds.length
  };
}

function appendReactionToLast(groups: ExploreSentenceGroup[], utterance: ExploreUtterance, text: string): boolean {
  const last = groups[groups.length - 1];
  if (!last || last.speakerId !== utterance.speakerId) return false;
  const timeLabel = timeLabelForUtterance(utterance);
  last.endSequence = utterance.sequence;
  last.text = appendText(last.text, text);
  last.timeLabel = last.timeLabel && timeLabel && last.timeLabel !== timeLabel ? `${last.timeLabel} - ${timeLabel}` : last.timeLabel || timeLabel;
  last.utteranceCount += 1;
  last.id = `${last.id}|${utterance.utteranceId}`;
  return true;
}

export function mergeUtterancesIntoSentences(utterances: ExploreUtterance[]): ExploreSentenceGroup[] {
  const groups: ExploreSentenceGroup[] = [];
  let current: WorkingSentenceGroup | null = null;

  const flush = (): void => {
    if (!current || current.parts.length === 0) {
      current = null;
      return;
    }
    groups.push(toSentenceGroup(current));
    current = null;
  };

  for (const utterance of utterances) {
    const text = textForUtterance(utterance);
    if (!text) continue;

    if (current && current.speakerId !== utterance.speakerId) flush();

    if (current && isShortReaction(text)) {
      const lastPart = current.parts[current.parts.length - 1] ?? '';
      current.parts[current.parts.length - 1] = appendText(lastPart, text);
      current.endSequence = utterance.sequence;
      current.endTimeLabel = timeLabelForUtterance(utterance);
      current.utteranceIds.push(utterance.utteranceId);
      if (hasTerminalPunctuation(text)) flush();
      continue;
    }

    if (!current && isShortReaction(text) && appendReactionToLast(groups, utterance, text)) {
      continue;
    }

    const timeLabel = timeLabelForUtterance(utterance);
    if (!current) {
      current = {
        speakerId: utterance.speakerId,
        startSequence: utterance.sequence,
        endSequence: utterance.sequence,
        startTimeLabel: timeLabel,
        endTimeLabel: timeLabel,
        parts: [],
        utteranceIds: []
      };
    }

    current.parts.push(text);
    current.endSequence = utterance.sequence;
    current.endTimeLabel = timeLabel;
    current.utteranceIds.push(utterance.utteranceId);

    if (hasTerminalPunctuation(text)) flush();
  }

  flush();
  return groups;
}

export function mergeSentenceGroupsIntoBundles(groups: ExploreSentenceGroup[]): ExploreSentenceGroup[] {
  const bundled: ExploreSentenceGroup[] = [];
  let current: ExploreSentenceGroup[] = [];

  const flush = (): void => {
    const group = toBundleGroup(current);
    if (group) bundled.push(group);
    current = [];
  };

  for (const group of groups) {
    if (!isShortBundleCandidate(group)) {
      flush();
      bundled.push({ ...group, sentenceCount: group.sentenceCount ?? 1 });
      continue;
    }

    if (!canAppendBundleGroup(current, group)) flush();
    current.push(group);
  }

  flush();
  return bundled;
}

export function mergeUtterancesIntoBundles(utterances: ExploreUtterance[]): ExploreSentenceGroup[] {
  return mergeSentenceGroupsIntoBundles(mergeUtterancesIntoSentences(utterances));
}
