import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { TraceRecord } from './controller.js';
import type { ClientScript, ServerScript } from './protocol.js';
import type { SourceResolver } from './sourcemap.js';

/** Files one test executed, split by where they ran. */
export interface MappedTest {
  title: string;
  /** Test file, relative to the repository root. */
  file: string;
  server: string[];
  client: string[];
}

/** `.isolate/map.json`: which repo files each test executed. All paths are repo-relative with forward slashes. */
export interface ImpactMap {
  version: 1;
  createdAt: string;
  /** git HEAD when the map was built, or null outside a git repository. */
  commit: string | null;
  workers: number;
  /** Files where a function other than the module top level ran before some worker's first test (D-011). */
  global: string[];
  /** Files whose only execution before the first test was their module top level. */
  bootLoaded: string[];
  tests: Record<string, MappedTest>;
  /** Names of the functions ever seen executing in each file (anonymous functions are left out). */
  executedFunctions: Record<string, string[]>;
  stats: {
    /** Takes between two tests of one worker that found executed code, attributed to the earlier test. */
    betweenTestTakes: number;
    /** Takes that went ahead with HTTP requests still in flight after the app's 2 s wait. */
    takeTimeouts: number;
    /** `<script url>: <reason>` for every script whose source map could not be used. */
    sourceMapFailures: string[];
    /** Browser script URLs that no client root or source map maps to a repo file. */
    unresolvedClientUrls: string[];
  };
}

/** Where the map was built, recorded in it. */
export interface MapContext {
  workers: number;
  commit: string | null;
}

type Resolve = (url: string, offset: number) => Promise<string | null>;

const sorted = (values: Iterable<string>): string[] => [...values].sort();

/** Builds the impact map from what the controller recorded, resolving every executed function to a repo file. */
export async function buildMap(record: TraceRecord, resolver: SourceResolver, context: MapContext): Promise<ImpactMap> {
  const functionNames = new Map<string, Set<string>>();
  const noteFunction = (file: string, name: string) => {
    if (name === '') return;
    const names = functionNames.get(file) ?? new Set<string>();
    names.add(name);
    functionNames.set(file, names);
  };

  const global = new Set<string>();
  const bootTopLevel = new Set<string>();
  for (const script of record.boot) {
    for (const fn of script.functions) {
      const file = await resolver.serverFile(script.url, fn.startOffset);
      if (file === null) continue;
      noteFunction(file, fn.name);
      (fn.isTopLevel ? bootTopLevel : global).add(file);
    }
  }

  const executedFiles = async (scripts: (ServerScript | ClientScript)[], resolve: Resolve): Promise<string[]> => {
    const files = new Set<string>();
    for (const script of scripts) {
      for (const fn of script.functions) {
        const file = await resolve(script.url, fn.startOffset);
        if (file === null) continue;
        noteFunction(file, fn.name);
        files.add(file);
      }
    }
    return sorted(files);
  };

  const tests: Record<string, MappedTest> = {};
  for (const id of sorted(record.tests.keys())) {
    const test = record.tests.get(id)!;
    const server = await executedFiles(test.server, (url, offset) => resolver.serverFile(url, offset));
    const client = await executedFiles(test.client, (url, offset) => resolver.clientFile(url, offset));
    tests[id] = { title: test.title, file: test.file, server, client };
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    commit: context.commit,
    workers: context.workers,
    global: sorted(global),
    bootLoaded: sorted([...bootTopLevel].filter((file) => !global.has(file))),
    tests,
    executedFunctions: Object.fromEntries(sorted(functionNames.keys()).map((file) => [file, sorted(functionNames.get(file)!)])),
    stats: {
      betweenTestTakes: record.betweenTestTakes,
      takeTimeouts: record.takeTimeouts,
      sourceMapFailures: sorted(resolver.sourceMapFailures),
      unresolvedClientUrls: sorted(resolver.unresolvedClientUrls),
    },
  };
}

/** Writes the map as indented JSON. */
export function writeMap(file: string, map: ImpactMap): void {
  writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
}

/** Reads a map written by `isolate trace`; throws with a hint if there is none or it has another version. */
export function readMap(file: string): ImpactMap {
  if (!existsSync(file)) throw new Error(`no impact map at ${file}; run \`isolate trace -- <playwright command>\` first`);
  const map = JSON.parse(readFileSync(file, 'utf8')) as Partial<ImpactMap>;
  if (map.version !== 1) throw new Error(`${file} has version ${String(map.version)}, expected 1; run \`isolate trace\` again`);
  return map as ImpactMap;
}
