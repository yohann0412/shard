/** Lines longer than this are broken up, one array item per line. */
const MAX_INLINE = 100;

const HEADER = `// Written by \`isolate init\`. Values under a "guessed" comment were not found in the repo: check them.
// Placeholders filled in per worker: {i} worker index, {port} app port, {url} app URL, {db} database URL.
`;

/** A string as a single-quoted TypeScript literal. */
function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n')}'`;
}

/** An object key: bare when it is an identifier, quoted otherwise. */
function renderKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
}

/** A value on one line: `'x'`, `3`, `['a', 'b']`, `{ a: 'b' }`. */
export function renderInline(value: unknown): string {
  if (typeof value === 'string') return quote(value);
  if (Array.isArray(value)) return `[${value.map(renderInline).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return entries.length === 0 ? '{}' : `{ ${entries.map(([k, v]) => `${renderKey(k)}: ${renderInline(v)}`).join(', ')} }`;
  }
  return String(value);
}

/** A value at an indentation: objects one key per line (with comments by key path), long arrays one item per line. */
function renderValue(value: unknown, keyPath: string, indent: string, comments: Map<string, string>): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    const inline = renderInline(value);
    const key = keyPath.slice(keyPath.lastIndexOf('.') + 1);
    if (`${indent}${key}: ${inline},`.length <= MAX_INLINE) return inline;
    return `[\n${value.map((item) => `${inner}${renderInline(item)},`).join('\n')}\n${indent}]`;
  }
  if (value === null || typeof value !== 'object') return renderInline(value);
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  const lines = entries.map(([key, child]) => {
    const childPath = keyPath === '' ? key : `${keyPath}.${key}`;
    const comment = comments.get(childPath);
    const commentLine = comment === undefined ? '' : `${inner}// ${comment}\n`;
    return `${commentLine}${inner}${renderKey(key)}: ${renderValue(child, childPath, inner, comments)},`;
  });
  return `{\n${lines.join('\n')}\n${indent}}`;
}

/**
 * Renders a config object as the source of `isolate.config.ts`: an exported object literal with no imports and only
 * erasable syntax, with a comment line above each key path in `comments` (e.g. `app.healthPath`). It is written as
 * `export default` in an ES module package and as `module.exports =` otherwise, so Node loads it without reparsing.
 */
export function renderConfig(config: object, comments: Map<string, string>, esm: boolean): string {
  return `${HEADER}${esm ? 'export default' : 'module.exports ='} ${renderValue(config, '', '', comments)};\n`;
}
