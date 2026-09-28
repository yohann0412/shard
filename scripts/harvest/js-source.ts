import { CODE, COMMENT, endOfQuoted, labelSource } from './js-lexer.js';

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CONTINUES_AFTER = new Set(['+', '-', '*', '/', '%', '&', '|', '?', ':', '=', '<', '>', ',', '.', '(', '[', '{', '!', '~', '^']);
const CONTINUES_BEFORE = new Set(['.', '?', ':', '+', '-', '*', '/', '%', '&', '|', '=', '<', '>', '^']);

/** One property of an object literal; `key` is null for a spread (`...expr`). */
export interface Property {
  key: string | null;
  start: number;
  end: number;
}

/** A JS/TS source file with comments blanked out, so text searches only see code and literals. */
export class SourceFile {
  readonly text: string;
  private readonly labels: Uint8Array;

  constructor(source: string) {
    this.labels = labelSource(source);
    const units = source.split('');
    this.text = units.map((unit, i) => (this.labels[i] === COMMENT && unit !== '\n' ? ' ' : unit)).join('');
  }

  /** True when the character at `index` is code (not inside a string, template text, regex or comment). */
  isCode(index: number): boolean {
    return this.labels[index] === CODE;
  }

  /** Index of the bracket closing the one at `open`, or the end of the text. */
  matchingClose(open: number): number {
    const stack: string[] = [];
    for (let i = open; i < this.text.length; i++) {
      if (!this.isCode(i)) continue;
      const c = this.text[i] ?? '';
      if (OPENERS[c] !== undefined) stack.push(OPENERS[c]);
      else if (c === ')' || c === ']' || c === '}') {
        stack.pop();
        if (stack.length === 0) return i;
      }
    }
    return this.text.length;
  }

  private significant(from: number, step: 1 | -1): string {
    for (let i = from; i >= 0 && i < this.text.length; i += step) {
      const c = this.text[i] ?? '';
      if (!/\s/.test(c)) return c;
    }
    return '';
  }

  /** End index (exclusive) of the expression starting at `start`: the next top-level `,` `;` or closing bracket. */
  expressionEnd(start: number): number {
    let depth = 0;
    for (let i = start; i < this.text.length; i++) {
      if (!this.isCode(i)) continue;
      const c = this.text[i] ?? '';
      if (OPENERS[c] !== undefined) depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) return i;
        depth--;
      } else if (depth === 0 && (c === ',' || c === ';')) return i;
      else if (depth === 0 && c === '\n' && this.text.slice(start, i).trim() !== '') {
        const before = this.significant(i - 1, -1);
        const after = this.significant(i + 1, 1);
        if (!CONTINUES_AFTER.has(before) && !CONTINUES_BEFORE.has(after)) return i;
      }
    }
    return this.text.length;
  }

  /** Trimmed text of the expression starting at `start`. */
  expressionAt(start: number): string {
    return this.text.slice(start, this.expressionEnd(start)).trim();
  }

  /** Index of the first non-whitespace character at or after `from`. */
  skipSpace(from: number): number {
    let i = from;
    while (i < this.text.length && /\s/.test(this.text[i] ?? '')) i++;
    return i;
  }

  /** The properties of the object literal whose `{` is at `open`. */
  properties(open: number): Property[] {
    const close = this.matchingClose(open);
    const found: Property[] = [];
    let i = open + 1;
    while (i < close) {
      i = this.skipSpace(i);
      if (i >= close) break;
      if (this.text[i] === ',') {
        i++;
        continue;
      }
      if (this.text.startsWith('...', i)) {
        const start = this.skipSpace(i + 3);
        const end = this.expressionEnd(start);
        found.push({ key: null, start, end });
        i = Math.max(end, i + 3);
        continue;
      }
      const key = this.readKey(i);
      if (key === null) {
        i = Math.max(this.expressionEnd(i), i + 1);
        continue;
      }
      const after = this.skipSpace(key.end);
      const c = this.text[after];
      if (c === ':') {
        const start = this.skipSpace(after + 1);
        const end = this.expressionEnd(start);
        found.push({ key: key.name, start, end });
        i = Math.max(end, after + 1);
      } else if (c === ',' || after >= close) {
        found.push({ key: key.name, start: i, end: key.end });
        i = after;
      } else {
        const bodyOpen = this.text.indexOf('{', after);
        i = bodyOpen < 0 || bodyOpen > close ? close : this.matchingClose(bodyOpen) + 1;
      }
    }
    return found;
  }

  private readKey(at: number): { name: string; end: number } | null {
    const c = this.text[at] ?? '';
    if (c === '"' || c === "'") {
      const end = endOfQuoted(this.text, at, c);
      return { name: this.text.slice(at + 1, end - 1), end };
    }
    if (c === '[') return { name: '[computed]', end: this.matchingClose(at) + 1 };
    const match = /^(?:(?:async|get|set)\s+)?([A-Za-z_$][\w$]*)/.exec(this.text.slice(at, at + 200));
    return match?.[1] === undefined ? null : { name: match[1], end: at + match[0].length };
  }

  /** Start index of the initializer of a top-level-looking `const|let|var name = ...`, or null. */
  declarationStart(name: string): number | null {
    const escaped = name.replace(/[$]/g, '\\$');
    const pattern = new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*(?::[^=;]*?)?=(?![=>])`, 'g');
    for (const match of this.text.matchAll(pattern)) {
      if (this.isCode(match.index)) return this.skipSpace(match.index + match[0].length);
    }
    return null;
  }

  /** Start index of the value of the first `name:` property anywhere in the code, or null. */
  firstPropertyValue(name: string): number | null {
    for (const match of this.text.matchAll(new RegExp(`\\b${name}\\s*:`, 'g'))) {
      if (this.isCode(match.index)) return this.skipSpace(match.index + match[0].length);
    }
    return null;
  }

  /** True when `pattern` matches somewhere in code (not in a comment or string). */
  codeMatches(pattern: RegExp): boolean {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of this.text.matchAll(global)) {
      if (this.isCode(match.index)) return true;
    }
    return false;
  }

  /** Relative module specifiers imported or required by this file (`./x`, `../y`). */
  relativeImports(): string[] {
    const specifiers = new Set<string>();
    const pattern = /\b(?:from|import|require\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
    for (const match of this.text.matchAll(pattern)) {
      if (this.isCode(match.index) && match[1] !== undefined) specifiers.add(match[1]);
    }
    return [...specifiers];
  }
}

/** True when an expression is a bare identifier. */
export function isIdentifier(expression: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(expression);
}

/** True when an expression is a string literal, or a template literal without substitutions. */
export function isStringLiteral(expression: string): boolean {
  const bare = expression.replace(/\s+as\s+const$/, '').trim();
  return /^(['"])(?:\\.|(?!\1)[^\\\n])*\1$/.test(bare) || /^`[^`$]*`$/.test(bare);
}
