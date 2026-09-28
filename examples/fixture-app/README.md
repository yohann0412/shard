# fixture-app

The smallest realistic app that shows why Playwright suites stay at `workers: 1`: one Express app, one Postgres
database, and 12 tests that are correct one at a time but collide when four workers share the app.

- Sign-in with database sessions, a dashboard, an item list, and a global maintenance switch stored in `settings`.
- `tests/items.spec.ts` and `tests/bulk-items.spec.ts` assert exact item counts, so concurrent item creators break them.
- `tests/maintenance.spec.ts` turns maintenance on for a few seconds, which shows a banner on every page and blocks
  item creation for everyone, so it breaks `tests/dashboard.spec.ts` and the item tests when they run at the same time.

## Run

From the repository root, after `pnpm install`:

```sh
just fixture-baseline   # workers 1 against one shared app: all 12 pass
just fixture-collide    # workers 4 against one shared app: some fail
```

Both build the app, then `scripts/with-db.mjs` starts a throwaway Postgres (from the `embedded-postgres` package) on a
free port, creates database `fixture`, runs `scripts/migrate.mjs` and `scripts/seed.mjs`, and runs Playwright with
`DATABASE_URL` set. Playwright's `webServer` starts the app on port 3000. Postgres and its temp directory are removed
when Playwright exits.

To run the app against your own database, export the variables from `.env.example` (the app reads the environment,
not `.env` files), then `pnpm migrate && pnpm seed && pnpm build && pnpm start`.
