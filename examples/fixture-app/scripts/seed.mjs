// Inserts the two test users, five items and the maintenance setting. Not idempotent: run it on a fresh database.
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('seed: DATABASE_URL is not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');
  await client.query(
    `insert into users (email, name, password) values
       ('alice@example.com', 'Alice', 'alice-password'),
       ('bob@example.com', 'Bob', 'bob-password')`,
  );
  await client.query("insert into items (name) select 'Seed item ' || n from generate_series(1, 5) as n order by n");
  await client.query("insert into settings (key, value) values ('maintenance', 'off')");
  await client.query('commit');
  console.log('seed: 2 users, 5 items, maintenance off');
} finally {
  await client.end();
}
