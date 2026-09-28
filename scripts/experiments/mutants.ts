/** `throw`: throw at the start of the first exported function. `toplevel`: change a module-scope literal. `wrongvalue`: return early. */
export type MutantKind = 'throw' | 'toplevel' | 'wrongvalue';

/** One mutant of one file. */
export interface Mutant {
  kind: MutantKind;
  file: string;
  /** 1-based line of the edit; the edit never adds or removes lines. */
  line: number;
  /** The mutated function's name ('default' for an anonymous default export), or '' for a module-scope edit. */
  functionName: string;
  /** Text whose count in the served build output must go up for the mutant to be live. */
  marker: string;
  description: string;
  /** The whole mutated file. */
  source: string;
}

/** Why a file has no mutant of some kind. */
export interface NoMutant {
  kind: MutantKind;
  file: string;
  skipped: string;
}

/** The string every string-changing mutant writes, so its presence in the build output can be checked. */
const MUTANT_MARKER = 'isolate-mutant';

const EXPORTED_FUNCTION = /^export\s+(?:default\s+)?(?:async\s+)?function\s*(\*?)\s*([A-Za-z_$][\w$]*)?\s*/gm;
const EXPORTED_CONST = /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s+)?/gm;
const MODULE_CONST = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)[^=\n]*=(?!=|>)/gm;
const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Index of the character that ends a string or template literal starting at `start`. */
function endOfString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === quote) return i;
  }
  return source.length - 1;
}

/** Index just before the next token after a comment starting at `start`, or `start` itself if no comment starts there. */
function skipComment(source: string, start: number): number {
  if (source.startsWith('//', start)) {
    const end = source.indexOf('\n', start);
    return end === -1 ? source.length : end;
  }
  if (source.startsWith('/*', start)) {
    const end = source.indexOf('*/', start + 2);
    return end === -1 ? source.length : end + 1;
  }
  return start;
}

/** Index of the bracket closing the one at `open`, skipping strings and comments; -1 if unbalanced. */
function matchingClose(source: string, open: number): number {
  const opener = source[open]!;
  const closer = CLOSERS[opener];
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"' || c === "'" || c === '`') i = endOfString(source, i);
    else if (skipComment(source, i) !== i) i = skipComment(source, i);
    else if (c === opener) depth++;
    else if (c === closer && --depth === 0) return i;
  }
  return -1;
}

/** The last non-space character before `index` (a space at the very start of the file). */
function previousNonSpace(source: string, index: number): string {
  for (let i = index - 1; i >= 0; i--) if (!/\s/.test(source[i]!)) return source[i]!;
  return ' ';
}

/**
 * The `{` opening a function body after its parameter list, or -1 (an overload or declaration ends with `;` first).
 * Braces right after `:`, `|`, `&`, `<`, `,`, `(`, `[` or `=` open an object type in the return type and are skipped.
 */
function bodyBrace(source: string, afterParams: number): number {
  for (let i = afterParams; i < source.length; i++) {
    const c = source[i]!;
    if (c === ';') return -1;
    if (c === '(' || c === '[') i = matchingClose(source, i);
    else if (c === '{' && ':|&<,([='.includes(previousNonSpace(source, i))) i = matchingClose(source, i);
    else if (c === '{') return i;
    if (i === -1) return -1;
  }
  return -1;
}

/** The body `{` of a function whose parameter list is the first `(` at or after `from`, or -1. */
function functionBody(source: string, from: number): number {
  const open = source.indexOf('(', from);
  const close = open === -1 ? -1 : matchingClose(source, open);
  return close === -1 ? -1 : bodyBrace(source, close + 1);
}

/** The body `{` of an arrow function starting at `from` (`(a) => {`, `a => {`, with an optional return type on the same line), or -1. */
function arrowBody(source: string, from: number): number {
  let after: number;
  if (/^[A-Za-z_$][\w$]*\s*=>/.test(source.slice(from))) {
    after = source.indexOf('=>', from);
  } else {
    const open = source.indexOf('(', from);
    if (open === -1 || !/^(<[^\n]*>)?\s*$/.test(source.slice(from, open))) return -1;
    const close = matchingClose(source, open);
    if (close === -1) return -1;
    const lineEnd = source.indexOf('\n', close);
    const arrow = source.slice(close + 1, lineEnd === -1 ? undefined : lineEnd).search(/^\s*(:[^\n]*?)?=>/);
    if (arrow === -1) return -1;
    after = source.indexOf('=>', close + 1 + arrow);
  }
  const body = source.slice(after + 2).search(/\S/);
  return body !== -1 && source[after + 2 + body] === '{' ? after + 2 + body : -1;
}

/** The first exported function with a block body: its name and the index of the body's `{`. */
function firstExportedFunction(source: string): { name: string; brace: number } | null {
  const candidates: { index: number; name: string; brace: () => number }[] = [];
  for (const match of source.matchAll(EXPORTED_FUNCTION)) {
    if (match[1] === '*') continue;
    candidates.push({ index: match.index, name: match[2] ?? 'default', brace: () => functionBody(source, match.index + match[0].length) });
  }
  for (const match of source.matchAll(EXPORTED_CONST)) {
    const start = match.index + match[0].length;
    const brace = source.startsWith('function', start) ? () => functionBody(source, start) : () => arrowBody(source, start);
    candidates.push({ index: match.index, name: match[1]!, brace });
  }
  candidates.sort((a, b) => a.index - b.index);
  for (const candidate of candidates) {
    const brace = candidate.brace();
    if (brace !== -1) return { name: candidate.name, brace };
  }
  return null;
}

/** The 1-based line of `index`. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** The first string or number literal of a declaration's initializer starting at `from`, before the statement ends. */
function firstLiteral(source: string, from: number): { start: number; end: number; text: string } | null {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const c = source[i]!;
    if (skipComment(source, i) !== i) {
      i = skipComment(source, i);
    } else if (c === '"' || c === "'") {
      return { start: i, end: endOfString(source, i) + 1, text: source.slice(i, endOfString(source, i) + 1) };
    } else if (c === '`') {
      i = endOfString(source, i);
    } else if (/\d/.test(c) && !/[\w$.]/.test(source[i - 1] ?? '')) {
      const number = /^\d+(\.\d+)?(?![\w.])/.exec(source.slice(i));
      if (number !== null) return { start: i, end: i + number[0].length, text: number[0] };
    } else if ('([{'.includes(c)) {
      depth++;
    } else if (')]}'.includes(c)) {
      depth--;
    } else if (depth <= 0 && (c === ';' || (c === '\n' && /\S/.test(source[i + 1] ?? '')))) {
      return null;
    }
  }
  return null;
}

/** Inserts `statement` right after the first exported function's body `{`, on the same line. */
function insertAtFunctionStart(file: string, source: string, kind: MutantKind, statement: string, marker: string): Mutant | NoMutant {
  const found = firstExportedFunction(source);
  if (found === null) return { kind, file, skipped: 'no exported function with a block body' };
  return {
    kind,
    file,
    line: lineOf(source, found.brace),
    functionName: found.name,
    marker,
    description: `${statement} at the start of ${found.name}()`,
    source: `${source.slice(0, found.brace + 1)} ${statement}${source.slice(found.brace + 1)}`,
  };
}

/** Changes the first string or number literal of the first module-scope `const` that has one. */
function changeTopLevelLiteral(file: string, source: string): Mutant | NoMutant {
  for (const match of source.matchAll(MODULE_CONST)) {
    const literal = firstLiteral(source, match.index + match[0].length);
    if (literal === null) continue;
    const isString = literal.text.startsWith('"') || literal.text.startsWith("'");
    const replacement = isString ? JSON.stringify(MUTANT_MARKER) : String(Number(literal.text) + 1);
    return {
      kind: 'toplevel',
      file,
      line: lineOf(source, literal.start),
      functionName: '',
      marker: isString ? MUTANT_MARKER : replacement,
      description: `${literal.text} → ${replacement} in const ${match[1]}`,
      source: `${source.slice(0, literal.start)}${replacement}${source.slice(literal.end)}`,
    };
  }
  return { kind: 'toplevel', file, skipped: 'no module-scope const with a string or number literal' };
}

/** Builds one mutant of a source file, or says why the file has none of that kind. */
export function makeMutant(file: string, source: string, kind: MutantKind): Mutant | NoMutant {
  if (kind === 'throw') return insertAtFunctionStart(file, source, kind, `throw new Error(${JSON.stringify(MUTANT_MARKER)});`, MUTANT_MARKER);
  if (kind === 'wrongvalue') {
    const typed = /\.[cm]?tsx?$/.test(file);
    return insertAtFunctionStart(file, source, kind, typed ? 'return undefined as never;' : 'return undefined;', 'return undefined');
  }
  return changeTopLevelLiteral(file, source);
}
