function isDigit(value: string | undefined): boolean {
  return value !== undefined && /\d/u.test(value);
}

function isSlashPartOfUrl(text: string, index: number): boolean {
  const previousWhitespace = Math.max(text.lastIndexOf(' ', index), text.lastIndexOf('\n', index), text.lastIndexOf('\t', index));
  const tokenStart = previousWhitespace + 1;
  return text.slice(tokenStart, index).includes('://');
}

function isInsideUrlToken(text: string, index: number): boolean {
  const previousWhitespace = Math.max(text.lastIndexOf(' ', index), text.lastIndexOf('\n', index), text.lastIndexOf('\t', index));
  const tokenStart = previousWhitespace + 1;
  const nextWhitespaceCandidates = [text.indexOf(' ', index), text.indexOf('\n', index), text.indexOf('\t', index)].filter((value) => value >= 0);
  const tokenEnd = nextWhitespaceCandidates.length ? Math.min(...nextWhitespaceCandidates) : text.length;
  return text.slice(tokenStart, tokenEnd).includes('://');
}

function isSentencePunctuation(value: string | undefined): boolean {
  return value !== undefined && /[.!?\u3002\uff1f\uff01]/u.test(value);
}

function isReactionLetter(value: string | undefined): boolean {
  return value !== undefined && /[\u314b\u314e\u315c\u3160]/u.test(value);
}

function pushSegment(segments: string[], buffer: string): string {
  const value = buffer.trim();
  if (value) segments.push(value);
  return '';
}

export function splitDisplaySegments(text: string): string[] {
  const segments: string[] = [];
  let buffer = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    const previous = text[index - 1];
    const next = text[index + 1];

    if (char === '\r') {
      index += 1;
      continue;
    }

    if (char === '\n') {
      buffer = pushSegment(segments, buffer);
      index += 1;
      continue;
    }

    if (char === '/') {
      if ((previous === ':' && next === '/') || (previous === '/' && text[index - 2] === ':') || isSlashPartOfUrl(text, index)) {
        buffer += char;
        index += 1;
        continue;
      }
      if (next === '/') {
        while (text[index] === '/') index += 1;
        buffer = pushSegment(segments, buffer);
        continue;
      }
      if ((!isDigit(previous) || !isDigit(next)) && previous !== ':' && previous !== '/' && next !== '/' && !isSlashPartOfUrl(text, index)) {
        buffer = pushSegment(segments, buffer);
        index += 1;
        continue;
      }
    }

    buffer += char;

    if (isSentencePunctuation(char) && !isInsideUrlToken(text, index) && !(char === '.' && isDigit(previous) && isDigit(next))) {
      while (isSentencePunctuation(text[index + 1])) {
        index += 1;
        buffer += text[index];
      }
      let whitespace = '';
      let lookahead = index + 1;
      while (/[ \t]/u.test(text[lookahead] ?? '')) {
        whitespace += text[lookahead];
        lookahead += 1;
      }
      if (isReactionLetter(text[lookahead])) {
        buffer += whitespace;
        index = lookahead - 1;
      }
      while (isReactionLetter(text[index + 1])) {
        index += 1;
        buffer += text[index];
      }
      buffer = pushSegment(segments, buffer);
      index += 1;
      continue;
    }

    if (isReactionLetter(char)) {
      while (isReactionLetter(text[index + 1])) {
        index += 1;
        buffer += text[index];
      }
      const afterRun = text[index + 1];
      if (afterRun && !/[\r\n/]/u.test(afterRun) && !isSentencePunctuation(afterRun)) {
        buffer = pushSegment(segments, buffer);
      }
    }

    index += 1;
  }

  buffer = pushSegment(segments, buffer);
  return segments.length ? segments : [text];
}
