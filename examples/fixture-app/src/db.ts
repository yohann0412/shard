import pg from 'pg';

let pool: pg.Pool | undefined;

/** Creates the connection pool every query goes through. */
export function createPool(url: string): void {
  pool = new pg.Pool({ connectionString: url });
  pool.on('error', (error) => console.error(`postgres pool error: ${error.message}`));
}

/** Runs one parameterized statement and returns its rows. */
export async function query<Row extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<Row[]> {
  if (pool === undefined) throw new Error('createPool() must run before query()');
  const result = await pool.query<Row>(sql, params);
  return result.rows;
}

/** Returns the name of the database the pool is connected to. */
export async function currentDatabase(): Promise<string> {
  const [row] = await query<{ name: string }>('select current_database() as name');
  if (row === undefined) throw new Error('select current_database() returned no row');
  return row.name;
}

/** Fails fast when the database is unreachable, and logs which database the app uses. */
export async function checkDatabase(): Promise<void> {
  console.log(`connected to database ${await currentDatabase()}`);
}
