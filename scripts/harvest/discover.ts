import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { cloneShallow, headCommit, remoteHead } from './git.js';
import type { PoolEntry } from './schema.js';

/** The seed list from the sprint spec, as GitHub `owner/repo`. */
export const SEED_LIST = [
  'calcom/cal.com',
  'formbricks/formbricks',
  'documenso/documenso',
  'twentyhq/twenty',
  'dubinc/dub',
  'mfts/papermark',
  'lukevella/rallly',
  'umami-software/umami',
  'payloadcms/payload',
  'strapi/strapi',
  'nocodb/nocodb',
  'saleor/saleor-dashboard',
  'mattermost/mattermost',
  'langfuse/langfuse',
  'gitroomhq/postiz-app',
  'Infisical/infisical',
  'triggerdotdev/trigger.dev',
  'makeplane/plane',
  'hoppscotch/hoppscotch',
  'TryGhost/Ghost',
  'immich-app/immich',
  'rhonda-rodododo/llamenos-platform',
  'mtlynch/screenjournal',
];

/** The awesome-selfhosted-data repository. */
export const AWESOME_SELFHOSTED_URL = 'https://github.com/awesome-selfhosted/awesome-selfhosted-data';

/** The spec's star filter. */
export const MIN_STARS = 200;

const JS_PLATFORMS = new Set(['Nodejs', 'Javascript', 'Deno']);

/** One `software/*.yml` entry of awesome-selfhosted-data, reduced to the fields the harvest needs. */
export interface SoftwareEntry {
  sourceCodeUrl: string;
  stars: number | null;
  updatedAt: string | null;
  archived: boolean;
  platforms: string[];
}

/** A cloned awesome-selfhosted-data snapshot. */
export interface AwesomeSnapshot {
  commit: string;
  commitDate: string;
  entries: SoftwareEntry[];
}

/** The ordered scan pool plus how many awesome-selfhosted entries each filter removed. */
export interface Pool {
  entries: PoolEntry[];
  awesomeInPool: number;
  filteredOut: Record<string, number>;
}

function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** Reads the handful of top-level fields the harvest needs from one YAML entry, line by line. */
function parseSoftwareYaml(text: string): SoftwareEntry {
  const fields = new Map<string, string>();
  const platforms: string[] = [];
  let inPlatforms = false;
  for (const line of text.split('\n')) {
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (inPlatforms && item?.[1] !== undefined) {
      platforms.push(unquote(item[1]));
      continue;
    }
    const field = /^([a-z_]+):\s*(.*)$/.exec(line);
    inPlatforms = field?.[1] === 'platforms';
    if (field?.[1] !== undefined && field[2] !== undefined) fields.set(field[1], unquote(field[2]));
  }
  const stars = fields.get('stargazers_count');
  return {
    sourceCodeUrl: fields.get('source_code_url') ?? '',
    stars: stars === undefined ? null : Number.parseInt(stars, 10),
    updatedAt: fields.get('updated_at') ?? null,
    archived: fields.get('archived') === 'true',
    platforms,
  };
}

/** Clones awesome-selfhosted-data afresh into `dir` and parses every software entry. */
export async function loadAwesomeSelfhosted(dir: string, signal: AbortSignal): Promise<AwesomeSnapshot> {
  await rm(dir, { recursive: true, force: true });
  await cloneShallow(AWESOME_SELFHOSTED_URL, dir, signal);
  const { sha, date } = await headCommit(dir, signal);
  const softwareDir = path.join(dir, 'software');
  const files = (await readdir(softwareDir)).filter((file) => file.endsWith('.yml')).sort();
  const entries = await Promise.all(
    files.map(async (file) => parseSoftwareYaml(await readFile(path.join(softwareDir, file), 'utf8'))),
  );
  return { commit: sha, commitDate: date, entries };
}

/** `owner/repo` for a GitHub repository URL, or null for anything else (org pages, other hosts). */
function githubRepoName(url: string): string | null {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

function jsFamily(entry: SoftwareEntry): boolean {
  return entry.platforms.some((platform) => JS_PLATFORMS.has(platform));
}

/**
 * Finds the awesome-selfhosted entry for a seed repository that is not listed under its own name:
 * a same-owner entry whose remote HEAD is the same commit (a renamed repository).
 */
async function findRenamed(seed: string, byName: Map<string, SoftwareEntry>, signal: AbortSignal) {
  const owner = seed.split('/')[0]?.toLowerCase();
  const sameOwner = [...byName.entries()].filter(([name]) => name.split('/')[0] === owner);
  if (sameOwner.length === 0) return null;
  const seedHead = await remoteHead(`https://github.com/${seed}`, signal);
  if (seedHead === null) return null;
  for (const [name, entry] of sameOwner) {
    if ((await remoteHead(`https://github.com/${name}`, signal)) === seedHead) return { name, entry };
  }
  return null;
}

/**
 * Builds the scan order: the seed list first, then awesome-selfhosted GitHub entries that are not archived,
 * have >= 200 stars and were updated within the cutoff, Node/JavaScript/Deno platforms first, each group by stars.
 */
export async function buildPool(snapshot: AwesomeSnapshot, cutoff: Date, signal: AbortSignal): Promise<Pool> {
  const starsSource = `awesome-selfhosted-data@${snapshot.commit.slice(0, 7)} (snapshot ${snapshot.commitDate})`;
  const filteredOut: Record<string, number> = {};
  const drop = (reason: string) => {
    filteredOut[reason] = (filteredOut[reason] ?? 0) + 1;
  };
  const byName = new Map<string, SoftwareEntry>();
  for (const entry of snapshot.entries) {
    const name = githubRepoName(entry.sourceCodeUrl);
    if (name === null) drop('not a GitHub repository URL');
    else if (byName.has(name.toLowerCase())) drop('duplicate source_code_url');
    else byName.set(name.toLowerCase(), entry);
  }

  const seeds: PoolEntry[] = [];
  const claimed = new Set<string>();
  for (const seed of SEED_LIST) {
    const direct = byName.get(seed.toLowerCase());
    const match = direct ? { name: seed.toLowerCase(), entry: direct } : await findRenamed(seed, byName, signal);
    if (match) claimed.add(match.name);
    const alias = match && match.name !== seed.toLowerCase() ? `, listed as ${match.name} with the same HEAD commit` : '';
    seeds.push({
      url: `https://github.com/${seed}`,
      name: seed,
      stars: match?.entry.stars ?? null,
      starsSource: match?.entry.stars != null ? `${starsSource}${alias}` : 'unavailable: GitHub API blocked in sandbox',
    });
  }

  const cutoffDay = cutoff.toISOString().slice(0, 10);
  const listed: Array<{ entry: PoolEntry; js: boolean }> = [];
  for (const [lowerName, entry] of byName) {
    const name = githubRepoName(entry.sourceCodeUrl) ?? lowerName;
    if (claimed.has(lowerName)) drop('already in seed list');
    else if (entry.archived) drop('archived');
    else if (entry.stars === null) drop('no star count');
    else if (entry.stars < MIN_STARS) drop(`stars < ${MIN_STARS}`);
    else if (entry.updatedAt === null || entry.updatedAt < cutoffDay) drop('updated_at older than 12 months');
    else {
      const url = `https://github.com/${name}`;
      listed.push({ entry: { url, name, stars: entry.stars, starsSource }, js: jsFamily(entry) });
    }
  }
  listed.sort(
    (a, b) =>
      Number(b.js) - Number(a.js) || (b.entry.stars ?? 0) - (a.entry.stars ?? 0) || a.entry.name.localeCompare(b.entry.name),
  );
  const awesome = listed.map(({ entry }) => entry);
  return { entries: [...seeds, ...awesome], awesomeInPool: awesome.length, filteredOut };
}
