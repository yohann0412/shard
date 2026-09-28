import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { log } from '../src/log.js';
import { AWESOME_SELFHOSTED_URL, buildPool, loadAwesomeSelfhosted, MIN_STARS, SEED_LIST } from './harvest/discover.js';
import { summaryMarkdown, tally } from './harvest/report.js';
import { scanRepo, type ScanResult } from './harvest/scan.js';
import { HarvestSchema, type Candidate, type Excluded, type PoolEntry } from './harvest/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK_DIR = path.join(ROOT, 'work');
const DATA_DIR = path.join(ROOT, 'data');
const USAGE = 'Usage: node dist/scripts/harvest.js [--target N] [--concurrency N] [--limit N]\n';

/** Runs `task` over `items` with at most `concurrency` in flight, starting no new item once `stop()` is true. */
async function runPool<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>, stop: () => boolean) {
  const results = new Map<T, R>();
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const item = items[next++] as T;
      results.set(item, await task(item));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer, got ${value}`);
  return parsed;
}

function outcome(result: ScanResult): string {
  return result.status === 'qualified' ? `qualified (${result.candidate.class})` : `excluded: ${result.excluded.reason}`;
}

/** Keeps the first repo per HEAD commit in pool order; later ones (renamed or mirrored repos) become duplicates. */
function dedupe(pool: PoolEntry[], results: Map<PoolEntry, ScanResult>) {
  const candidates: Candidate[] = [];
  const excluded: Excluded[] = [];
  const seen = new Map<string, string>();
  for (const entry of pool) {
    const result = results.get(entry);
    if (result === undefined) continue;
    const owner = result.headCommit === null ? undefined : seen.get(result.headCommit);
    if (owner !== undefined) {
      excluded.push({ url: entry.url, reason: 'duplicate', detail: `same HEAD commit as ${owner}` });
      continue;
    }
    if (result.headCommit !== null) seen.set(result.headCommit, entry.name);
    if (result.status === 'qualified') candidates.push(result.candidate);
    else excluded.push(result.excluded);
  }
  return { candidates, excluded };
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { target: { type: 'string' }, concurrency: { type: 'string' }, limit: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const target = positiveInt(values.target, 100, 'target');
  const concurrency = positiveInt(values.concurrency, 8, 'concurrency');
  const limit = positiveInt(values.limit, Number.MAX_SAFE_INTEGER, 'limit');

  const harvestedAt = new Date();
  const cutoff = new Date(harvestedAt);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);

  log.info('cloning awesome-selfhosted-data');
  const snapshot = await loadAwesomeSelfhosted(path.join(WORK_DIR, 'awesome-selfhosted-data'), AbortSignal.timeout(300_000));
  const pool = await buildPool(snapshot, cutoff, AbortSignal.timeout(300_000));
  const entries = pool.entries.slice(0, limit);
  log.info({ seeds: SEED_LIST.length, awesome: pool.awesomeInPool, scanning: entries.length, target }, 'pool built');

  const clonesDir = path.join(WORK_DIR, 'harvest-clones');
  await rm(clonesDir, { recursive: true, force: true });
  await mkdir(clonesDir, { recursive: true });
  let qualified = 0;
  let done = 0;
  const results = await runPool(
    entries,
    concurrency,
    async (entry) => {
      const result = await scanRepo(entry, { clonesDir, cutoff });
      if (result.status === 'qualified') qualified++;
      done++;
      log.info({ done, qualified }, `${entry.name}: ${outcome(result)}`);
      return result;
    },
    () => qualified >= target,
  );
  await rm(clonesDir, { recursive: true, force: true });

  const { candidates, excluded } = dedupe(entries, results);
  const scanned = results.size;
  const harvest = HarvestSchema.parse({
    harvestedAt: harvestedAt.toISOString(),
    sources: {
      seedList: SEED_LIST,
      awesomeSelfhostedData: {
        url: AWESOME_SELFHOSTED_URL,
        commit: snapshot.commit,
        commitDate: snapshot.commitDate,
        entries: snapshot.entries.length,
        pool: pool.awesomeInPool,
        poolFilteredOut: pool.filteredOut,
      },
    },
    criteria: {
      playwrightConfig: 'playwright.config.(ts|js|mjs|cjs) anywhere outside node_modules',
      minStars: MIN_STARS,
      lastPushAfter: cutoff.toISOString(),
      databaseEvidence: [
        'schema.prisma (or any .prisma file under prisma/)',
        'drizzle.config.*',
        'docker-compose*.y*ml / compose*.y*ml mentioning postgres',
        'DATABASE_URL in an .env example/sample/template',
      ],
      target,
      order: 'seed list, then awesome-selfhosted Nodejs/Javascript/Deno entries by stars, then the rest by stars',
    },
    counts: {
      scanned,
      qualified: candidates.length,
      notScanned: pool.entries.length - scanned,
      byClass: {
        A: candidates.filter((c) => c.class === 'A').length,
        B: candidates.filter((c) => c.class === 'B').length,
        C: candidates.filter((c) => c.class === 'C').length,
      },
      byExclusionReason: tally(excluded.map((e) => e.reason)),
    },
    candidates,
    excluded,
  });

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, 'repos.json'), `${JSON.stringify(harvest, null, 2)}\n`);
  const summary = summaryMarkdown(harvest);
  await writeFile(path.join(DATA_DIR, 'harvest-summary.md'), summary);
  process.stdout.write(summary);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
