import { readFileSync, statSync } from 'node:fs';
import { SourceMap, type SourceMapPayload } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A browser URL path prefix served from a repo directory, from `trace.clientRoots` in the config. */
export interface ClientRoot {
  urlPrefix: string;
  dir: string;
}

/** How long to wait for a client source map fetched from the app. */
const FETCH_TIMEOUT_MS = 5000;

/** Schemes of bundler module URLs; the path after them names a repo file (webpack-internal:///(rsc)/./src/x.ts). */
const BUNDLER_PROTOCOLS = new Set(['webpack:', 'webpack-internal:']);

/** A source map loaded for one script, with what is needed to turn an offset into a repo file. */
interface MappedScript {
  kind: 'map';
  map: SourceMap;
  /** Offset of the first character of every line of the generated script. */
  lineStarts: number[];
  /** URL the map's sources are resolved against: the map file's own URL, or the script's for an inline map. */
  base: string;
  sourceRoot: string;
  /** Repo file of each source string seen so far (null: not a repo file). */
  files: Map<string, string | null>;
  /** The map's only source, for offsets before its first mapping (e.g. a "use strict" preamble); else null. */
  only: string | null;
}

/** What is known about one script URL. */
type ScriptMapping = MappedScript | { kind: 'file'; file: string } | { kind: 'none' };

const NONE: ScriptMapping = { kind: 'none' };

function isFile(file: string): boolean {
  return statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Offsets at which each line of `text` starts. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  return starts;
}

/** Zero-based line and column of an offset, given the line starts. */
function position(starts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low, column: offset - starts[low]! };
}

/** The URL in the script's last `//# sourceMappingURL=` comment, or null. */
function sourceMapReference(text: string): string | null {
  const matches = [...text.matchAll(/^[ \t]*\/\/[#@][ \t]*sourceMappingURL=([^\s'"]+)[ \t]*$/gm)];
  return matches.at(-1)?.[1] ?? null;
}

/** Decodes a `data:` URL holding a source map (base64 or percent-encoded JSON). */
function decodeDataUrl(url: string): SourceMapPayload {
  const comma = url.indexOf(',');
  const data = url.slice(comma + 1);
  const json = url.slice(0, comma).endsWith(';base64') ? Buffer.from(data, 'base64').toString('utf8') : decodeURIComponent(data);
  return JSON.parse(json) as SourceMapPayload;
}

/** Strips a leading BOM, which Node's loaders drop before V8 sees the source, so offsets line up. */
function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Maps executed functions (script URL + start offset) to repo files, relative to the repo root with forward slashes.
 * Server scripts: file:// URLs through their source map (file or inline), else the script itself if it is in the repo;
 * bundler URLs by their path. Browser scripts: `clientRoots` first, then source maps (inline or fetched from the app),
 * else the URL is recorded as unresolved. Everything is cached per URL; failures are recorded, never thrown.
 */
export class SourceResolver {
  /** `<url>: <reason>` for every script whose source map could not be used. */
  readonly sourceMapFailures = new Set<string>();
  /** Browser script URLs that no client root or source map maps to the repo. */
  readonly unresolvedClientUrls = new Set<string>();
  private readonly scripts = new Map<string, Promise<ScriptMapping>>();

  /**
   * @param root Real path of the repository root.
   * @param clientRoots From the config's `trace.clientRoots`.
   * @param clientSources Browser script sources (those with a source map comment) by URL, as the workers sent them.
   */
  constructor(
    private readonly root: string,
    private readonly clientRoots: ClientRoot[],
    private readonly clientSources: Map<string, string>,
  ) {}

  /** Repo file of the server function starting at `offset` in the script at `url`, or null. */
  async serverFile(url: string, offset: number): Promise<string | null> {
    return this.fileAt(await this.cached(url, () => this.mapServerScript(url)), offset);
  }

  /** Repo file of the browser function starting at `offset` in the script at `url`, or null. */
  async clientFile(url: string, offset: number): Promise<string | null> {
    return this.fileAt(await this.cached(url, () => this.mapClientScript(url)), offset);
  }

  private cached(url: string, load: () => Promise<ScriptMapping>): Promise<ScriptMapping> {
    let mapping = this.scripts.get(url);
    if (mapping === undefined) {
      mapping = load();
      this.scripts.set(url, mapping);
    }
    return mapping;
  }

  private fileAt(mapping: ScriptMapping, offset: number): string | null {
    if (mapping.kind !== 'map') return mapping.kind === 'file' ? mapping.file : null;
    const { line, column } = position(mapping.lineStarts, offset);
    const entry = mapping.map.findEntry(line, column) as { originalSource?: string };
    if (entry.originalSource === undefined) return mapping.only;
    return this.sourceFile(mapping, entry.originalSource);
  }

  /** Repo file of one source string of a map, resolved against the map's location (cached per map). */
  private sourceFile(mapping: MappedScript, source: string): string | null {
    let file = mapping.files.get(source);
    if (file === undefined) {
      file = this.resolveSource(source, mapping.base, mapping.sourceRoot);
      mapping.files.set(source, file);
    }
    return file;
  }

  private resolveSource(source: string, base: string, sourceRoot: string): string | null {
    const rooted = sourceRoot !== '' && !/^([a-z][a-z0-9+.-]*:|\/)/i.test(source) ? `${sourceRoot.replace(/\/?$/, '/')}${source}` : source;
    let url: URL;
    try {
      url = new URL(rooted, base);
    } catch {
      return null;
    }
    if (url.protocol === 'file:') return this.repoFile(fileURLToPath(url));
    if (BUNDLER_PROTOCOLS.has(url.protocol)) return this.bundlerFile(url);
    const pathname = decodeURIComponent(url.pathname);
    return this.repoFile(pathname) ?? this.repoRelative(pathname.slice(1));
  }

  /** The repo-relative form of an absolute path, if it is a file in the repo outside node_modules. */
  private repoFile(absolute: string): string | null {
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return this.repoRelative(relative.split(path.sep).join('/'));
  }

  /** A repo-relative path, normalized, if it names a file in the repo outside node_modules. */
  private repoRelative(relative: string): string | null {
    const normalized = path.posix.normalize(relative);
    if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return null;
    if (normalized.split('/').includes('node_modules')) return null;
    return isFile(path.join(this.root, normalized)) ? normalized : null;
  }

  /** The file a bundler module URL names: its path without a leading `(layer)/` segment. */
  private bundlerFile(url: URL): string | null {
    return this.repoRelative(decodeURIComponent(url.pathname).replace(/^\/+/, '').replace(/^\([^)]*\)\//, ''));
  }

  private mapped(payload: SourceMapPayload, base: string, text: string): MappedScript {
    const sources = payload.sources ?? [];
    const mapping: MappedScript = {
      kind: 'map',
      map: new SourceMap(payload),
      lineStarts: lineStarts(text),
      base,
      sourceRoot: payload.sourceRoot ?? '',
      files: new Map(),
      only: null,
    };
    if (sources.length === 1) mapping.only = this.sourceFile(mapping, sources[0]!);
    return mapping;
  }

  /** A script read from disk: through its source map if it has one, else the file itself if it is in the repo. */
  private mapLocalScript(file: string, url: string): ScriptMapping {
    let text: string;
    try {
      text = withoutBom(readFileSync(file, 'utf8'));
    } catch (error) {
      this.sourceMapFailures.add(`${url}: cannot read ${file}: ${describe(error)}`);
      return NONE;
    }
    const reference = sourceMapReference(text);
    if (reference !== null) {
      try {
        const scriptUrl = pathToFileURL(file).href;
        if (reference.startsWith('data:')) return this.mapped(decodeDataUrl(reference), scriptUrl, text);
        const mapUrl = new URL(reference, scriptUrl);
        if (mapUrl.protocol !== 'file:') throw new Error(`source map ${mapUrl.href} is not a file`);
        const payload = JSON.parse(readFileSync(fileURLToPath(mapUrl), 'utf8')) as SourceMapPayload;
        return this.mapped(payload, mapUrl.href, text);
      } catch (error) {
        this.sourceMapFailures.add(`${url}: ${describe(error)}`);
      }
    }
    const own = this.repoFile(file);
    return own === null ? NONE : { kind: 'file', file: own };
  }

  private async mapServerScript(url: string): Promise<ScriptMapping> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return NONE;
    }
    if (parsed.protocol === 'file:') return this.mapLocalScript(fileURLToPath(parsed), url);
    if (!BUNDLER_PROTOCOLS.has(parsed.protocol)) return NONE;
    const file = this.bundlerFile(parsed);
    if (file === null) this.sourceMapFailures.add(`${url}: the bundler URL does not name a repo file`);
    return file === null ? NONE : { kind: 'file', file };
  }

  /** The repo file a browser URL is served from, per `clientRoots`, or null. */
  private clientRootFile(url: URL): string | null {
    const pathname = decodeURIComponent(url.pathname);
    for (const { urlPrefix, dir } of this.clientRoots) {
      if (!pathname.startsWith(urlPrefix)) continue;
      const file = path.join(this.root, dir, pathname.slice(urlPrefix.length));
      if (isFile(file)) return file;
    }
    return null;
  }

  private async mapClientScript(url: string): Promise<ScriptMapping> {
    const parsed = new URL(url);
    const local = this.clientRootFile(parsed);
    if (local !== null) return this.mapLocalScript(local, url);
    const source = this.clientSources.get(url);
    const reference = source === undefined ? null : sourceMapReference(source);
    if (source !== undefined && reference !== null) {
      try {
        const mapUrl = new URL(reference, parsed);
        const payload = mapUrl.protocol === 'data:' ? decodeDataUrl(mapUrl.href) : await this.fetchMap(mapUrl);
        return this.mapped(payload, mapUrl.protocol === 'data:' ? url : mapUrl.href, source);
      } catch (error) {
        this.sourceMapFailures.add(`${url}: ${describe(error)}`);
      }
    }
    this.unresolvedClientUrls.add(url);
    return NONE;
  }

  private async fetchMap(mapUrl: URL): Promise<SourceMapPayload> {
    const response = await fetch(mapUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`fetching ${mapUrl.href}: HTTP ${response.status}`);
    return (await response.json()) as SourceMapPayload;
  }
}
