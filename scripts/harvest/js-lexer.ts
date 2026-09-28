/** Label of a code character that is neither in a literal nor in a comment. */
export const CODE = 0;
/** Label of a character inside a string, template text or regex literal. */
const LITERAL = 1;
/** Label of a character inside a comment. */
export const COMMENT = 2;

const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** Index just past the string literal opened by `quote` at `start` (or the end of its line). */
export function endOfQuoted(src: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < src.length && src[i] !== quote && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
  return Math.min(i + 1, src.length);
}

function endOfRegex(src: string, start: number): number | null {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') return null;
    if (c === '\\') i++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let end = i + 1;
      while (end < src.length && /[a-z]/.test(src[end] ?? '')) end++;
      return end;
    }
  }
  return null;
}

/** Labels every character of a JS/TS source as code, literal (string, template text, regex) or comment. */
export function labelSource(src: string): Uint8Array {
  const labels = new Uint8Array(src.length);
  const templateDepths: number[] = [];
  let depth = 0;
  let previous = '';
  let i = 0;
  const mark = (from: number, to: number, label: number) => labels.fill(label, from, to);
  const templateText = (from: number): number => {
    let j = from;
    while (j < src.length) {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '`') {
        mark(from, j + 1, LITERAL);
        previous = '`';
        return j + 1;
      } else if (src[j] === '$' && src[j + 1] === '{') {
        mark(from, j, LITERAL);
        depth++;
        templateDepths.push(depth);
        previous = '{';
        return j + 2;
      } else j++;
    }
    mark(from, src.length, LITERAL);
    return src.length;
  };
  while (i < src.length) {
    const c = src[i] ?? '';
    const next = src[i + 1];
    const regexEnd = c === '/' && REGEX_PRECEDERS.has(previous) ? endOfRegex(src, i) : null;
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      mark(i, stop, COMMENT);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      mark(i, stop, COMMENT);
      i = stop;
    } else if (c === '"' || c === "'") {
      const stop = endOfQuoted(src, i, c);
      mark(i, stop, LITERAL);
      previous = c;
      i = stop;
    } else if (c === '`') {
      labels[i] = LITERAL;
      i = templateText(i + 1);
    } else if (regexEnd !== null) {
      mark(i, regexEnd, LITERAL);
      previous = '/';
      i = regexEnd;
    } else if (c === '}' && templateDepths.at(-1) === depth) {
      templateDepths.pop();
      depth--;
      i = templateText(i + 1);
    } else {
      if (c === '{') depth++;
      if (c === '}') depth--;
      if (!/\s/.test(c)) previous = c;
      i++;
    }
  }
  return labels;
}
