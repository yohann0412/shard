import { rm } from 'node:fs/promises';
import path from 'node:path';
import { classify } from './classify.js';
import { analyzeConfig, localImports, playwrightVersion } from './detect-playwright.js';
import { docPaths, documentedE2E, findE2EScript } from './detect-e2e.js';
import { MIN_STARS } from './discover.js';
import { databaseEvidence, detectDatabase, detectOrm } from './detect-database.js';
import { detectLanguage } from './detect-language.js';
import { detectServices } from './detect-services.js';
import { cloneTreeOnly, headCommit, listTree, prefetchBlobs, showFile, type TreeEntry } from './git.js';
import { SourceFile } from './js-source.js';
import { COMPOSE_FILE, DRIZZLE_CONFIG, ENV_EXAMPLE, PACKAGE_JSON, PLAYWRIGHT_CONFIG, PRISMA_SCHEMA } from './patterns.js';
import { depth, dirOf, isExampleLike, join, RepoSnapshot, selfAndAncestors } from './repo.js';
import type { Candidate, Excluded, PoolEntry } from './schema.js';

const SCAN_TIMEOUT_MS = 90_000;

/** The outcome of scanning one pool entry; `headCommit` is set whenever the clone succeeded. */
export type ScanResult =
  | { status: 'qualified'; candidate: Candidate; headCommit: string }
  | { status: 'excluded'; excluded: Excluded; headCommit: string | null };

/** Shared settings for every scan. */
export interface ScanContext {
  clonesDir: string;
  cutoff: Date;
}

/** Up to `limit` paths matching `pattern`, shallowest first. */
function pick(paths: string[], pattern: RegExp, limit: number): string[] {
  return paths
    .filter((p) => pattern.test(p))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, limit);
}

const LEGACY = /(^|\/|[-_.])(legacy|old|deprecated|archived?)([-_./]|$)/i;

/** Playwright configs, preferring ones outside example directories, then non-legacy ones, then shallower ones. */
function orderConfigs(paths: string[]): string[] {
  const rank = (p: string) => [Number(isExampleLike(p)), Number(LEGACY.test(p)), depth(p)];
  return paths
    .filter((p) => PLAYWRIGHT_CONFIG.test(p))
    .sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)];
      return ra.map((value, i) => value - (rb[i] ?? 0)).find((diff) => diff !== 0) ?? a.localeCompare(b);
    });
}

/** The files a scan reads: configs, manifests, env examples, compose files, schemas and docs. */
function filesToRead(paths: string[], configs: string[]): string[] {
  const configDirs = configs.slice(0, 10).flatMap((config) => selfAndAncestors(dirOf(config)));
  const nearConfigs = configDirs.flatMap((dir) => [join(dir, 'package.json'), join(dir, 'project.json')]);
  const wanted = [
    ...configs.slice(0, 10),
    ...nearConfigs,
    ...pick(paths.filter((p) => !isExampleLike(p)), PACKAGE_JSON, 200),
    ...pick(paths, ENV_EXAMPLE, 40),
    ...pick(paths, COMPOSE_FILE, 30),
    ...pick(paths, /(^|\/)schema\.prisma$/, 10),
    ...pick(paths, PRISMA_SCHEMA, 20),
    ...pick(paths, DRIZZLE_CONFIG, 10),
    ...docPaths(paths, configs[0] ?? '').slice(0, 30),
    'pnpm-workspace.yaml',
  ];
  const present = new Set(paths);
  return [...new Set(wanted)].filter((p) => present.has(p));
}

async function readFiles(dir: string, entries: TreeEntry[], wanted: string[], signal: AbortSignal) {
  const oids = new Map(entries.map((entry) => [entry.path, entry.oid]));
  await prefetchBlobs(dir, wanted.map((p) => oids.get(p) ?? '').filter(Boolean), signal);
  const contents = new Map<string, string>();
  for (const p of wanted) contents.set(p, await showFile(dir, p, signal));
  return contents;
}

function excluded(entry: PoolEntry, reason: Excluded['reason'], detail: string, sha: string | null): ScanResult {
  return { status: 'excluded', excluded: { url: entry.url, reason, detail }, headCommit: sha };
}

async function inspect(entry: PoolEntry, dir: string, context: ScanContext, signal: AbortSignal): Promise<ScanResult> {
  const head = await headCommit(dir, signal);
  const entries = (await listTree(dir, signal)).filter((e) => !/(^|\/)node_modules\//.test(e.path));
  const paths = entries.map((e) => e.path);
  const configs = orderConfigs(paths);
  if (new Date(head.date) < context.cutoff) {
    const also = configs.length === 0 ? '; also no playwright config' : '';
    return excluded(entry, 'stale', `HEAD commit ${head.date}${also}`, head.sha);
  }
  if (configs.length === 0) return excluded(entry, 'no playwright config', `${paths.length} files in HEAD`, head.sha);

  const contents = await readFiles(dir, entries, filesToRead(paths, configs), signal);
  const primary = configs[0] ?? '';
  const configSource = contents.get(primary) ?? '';
  const importPaths = localImports(new RepoSnapshot(paths, contents), primary, configSource);
  const imported = await readFiles(dir, entries, importPaths.filter((p) => !contents.has(p)), signal);
  for (const [p, text] of imported) contents.set(p, text);
  const repo = new RepoSnapshot(paths, contents);

  const dbEvidence = databaseEvidence(repo);
  if (dbEvidence.length === 0) {
    const detail = 'no schema.prisma, drizzle.config.*, compose file mentioning postgres, or DATABASE_URL in an env example';
    return excluded(entry, 'no DB evidence', detail, head.sha);
  }

  const configFiles = [primary, ...importPaths].map((p): [string, string] => [p, contents.get(p) ?? '']);
  const e2eSources = configFiles.map(([p, text]): [string, string] => [p, new SourceFile(text).text]);
  const e2eScript = findE2EScript(repo, primary);
  const backendLanguage = detectLanguage(repo);
  const facts = {
    backendLanguage,
    database: detectDatabase(repo),
    unmanagedServices: detectServices(repo, e2eSources),
    documentedE2E: documentedE2E(repo, e2eScript),
  };
  const candidate: Candidate = {
    url: entry.url,
    name: entry.name,
    headCommit: head.sha,
    stars: entry.stars,
    starsSource: entry.starsSource,
    meetsStarFilter: entry.stars === null ? 'unknown' : entry.stars >= MIN_STARS,
    lastPush: head.date,
    lastPushSource: 'HEAD commit date',
    playwrightVersion: playwrightVersion(repo, primary),
    playwrightConfigPath: primary,
    otherPlaywrightConfigs: configs.slice(1),
    ...analyzeConfig(configFiles.map(([, text]) => text)),
    ...facts,
    orm: detectOrm(repo, backendLanguage.kind),
    e2eScript,
    ...classify(facts),
  };
  return { status: 'qualified', candidate, headCommit: head.sha };
}

function describe(error: unknown): string {
  const message = error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
  return message.split('\n')[0]?.slice(0, 200) ?? 'unknown error';
}

/** Clones one repository (one retry on clone failure, 90 s budget per attempt), checks the criteria and runs the detectors. */
export async function scanRepo(entry: PoolEntry, context: ScanContext): Promise<ScanResult> {
  if (entry.stars !== null && entry.stars < MIN_STARS) {
    return excluded(entry, 'low stars', `${entry.stars} stars (${entry.starsSource})`, null);
  }
  const slug = entry.name.replace(/[^\w.-]/g, '_');
  let lastError = '';
  for (const attempt of [1, 2]) {
    const dir = path.join(context.clonesDir, `${slug}-${attempt}`);
    const signal = AbortSignal.timeout(SCAN_TIMEOUT_MS);
    try {
      try {
        await cloneTreeOnly(entry.url, dir, signal);
      } catch (error) {
        lastError = signal.aborted ? `clone exceeded ${SCAN_TIMEOUT_MS / 1000} s` : describe(error);
        continue;
      }
      try {
        return await inspect(entry, dir, context, signal);
      } catch (error) {
        const reason = signal.aborted ? 'timeout' : 'clone failed';
        const detail = signal.aborted ? `scan exceeded ${SCAN_TIMEOUT_MS / 1000} s` : `reading files failed: ${describe(error)}`;
        return excluded(entry, reason, detail, null);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const reason = lastError.startsWith('clone exceeded') ? 'timeout' : 'clone failed';
  return excluded(entry, reason, `${lastError} (after one retry)`, null);
}
