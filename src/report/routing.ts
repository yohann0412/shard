import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

/** Committed transactions of one database during the tests. */
export interface DbActivity {
  name: string;
  xactCommitDelta: number;
}

/**
 * A backend flushes its statistics at most once a second; what it could not flush then waits until it has been idle
 * for PGSTAT_IDLE_INTERVAL (10 s). So a database that just served its first queries can look idle for up to ~10 s.
 */
const SETTLE_TIMEOUT_MS = 11_000;
const SETTLE_POLL_MS = 250;

/** Reads `xact_commit` from pg_stat_database for each named database (0 for a database without statistics yet). */
export async function readXactCommits(adminUrl: string, names: string[]): Promise<Map<string, number>> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const result = await client.query<{ datname: string; xact_commit: string }>(
      'SELECT datname, xact_commit::text FROM pg_stat_database WHERE datname = ANY($1)',
      [names],
    );
    const commits = new Map(names.map((name) => [name, 0]));
    for (const row of result.rows) commits.set(row.datname, Number(row.xact_commit));
    return commits;
  } finally {
    await client.end();
  }
}

/**
 * Measures from outside the test process how many transactions every database committed since `before`, the routing
 * verdict's evidence that each app uses its own database (RISKS R3). While a `used` database looks idle, polls for up
 * to 11 s, so that statistics the backends have not flushed yet are not mistaken for no traffic.
 */
export async function measureDbActivity(adminUrl: string, before: Map<string, number>, used: string[]): Promise<DbActivity[]> {
  const deadline = performance.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const after = await readXactCommits(adminUrl, [...before.keys()]);
    const dbActivity = [...before].map(([name, commits]) => ({ name, xactCommitDelta: (after.get(name) ?? 0) - commits }));
    const idle = dbActivity.some((db) => used.includes(db.name) && db.xactCommitDelta <= 0);
    if (!idle || performance.now() >= deadline) return dbActivity;
    await sleep(SETTLE_POLL_MS);
  }
}
