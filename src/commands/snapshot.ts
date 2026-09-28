import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.js';
import { log } from '../log.js';
import { formatSize } from '../snapshot/plan.js';
import { entryBytes } from '../snapshot/store.js';
import { startStack } from '../stack.js';

/**
 * `isolate snapshot`: builds (if configured), migrates and seeds from scratch, saves both cache entries (replacing any
 * with the same keys), then stops. Prints each key and size, and one `snapshot` JSON line on stdout with the keys, sizes
 * in bytes and phase times in ms.
 */
export async function main(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length > 0) {
    log.error('usage: isolate snapshot');
    return 2;
  }
  const repoDir = process.cwd();
  const stack = await startStack({ repoDir, config: await loadConfig(repoDir), workers: 0, apps: false, build: true, cache: 'refresh' });
  await stack.stop();

  const db = { key: stack.cache.db.key, bytes: entryBytes(repoDir, 'db', stack.cache.db.key) ?? 0 };
  const buildKey = stack.cache.build?.key ?? null;
  const build = buildKey === null ? null : { key: buildKey, bytes: entryBytes(repoDir, 'build', buildKey) ?? 0 };
  log.info(`database ${db.key} (${formatSize(db.bytes)})`);
  if (build !== null) log.info(`build ${build.key} (${formatSize(build.bytes)})`);
  else log.info(stack.cache.build === null ? 'no build configured' : 'build not cached (the reason is above)');
  process.stdout.write(`${JSON.stringify({ event: 'snapshot', db, build, timings: stack.timings })}\n`);
  return 0;
}
