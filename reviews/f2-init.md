# Review: F2 (config and detection, `isolate init`)

Subagent report: detection split into 17 small detectors; `webServer` read through a probe config evaluated by the repo's own Playwright (`--list` with a filter that matches no file); unmanaged-service scan over workspace dependencies, committed `.env*` keys and compose images; the refusal half of f2 passed by hand; the `run` half could not run in its tree. The four hooks it specified (placeholders in `app.start`, `unmanaged` in the report schema and builder, the scan in the session) were applied by the lead during integration.

## What could be wrong

- **Detection is text-based and can be confidently wrong.** On umami it proposed `db.seed = pnpm db:seed`, which is a demo-data generator; on rallly and umami it guessed `healthPath: /`, while the real endpoints are `/api/status` and `/api/heartbeat`. `/` usually works (it answers 200 or a redirect) but can be slow on a cold Next.js server and may itself touch the database. Guessed values are marked `// guessed:` in the written config, which is the right behaviour; users must read the file.
- **The probe runs the repo's Playwright config with `CI=true` when unset.** That makes it pick CI branches (for rallly, `next start` instead of `next dev`), which is what we want for isolation, but a config that does heavy work at load time (network calls, file writes) would do them during `init`.
- **Copying `.env.test` values into `app.env`** means isolate's config then overrides the environment where dotenv would only have filled unset keys. The subagent flags it with a warning. For rallly this silently pins `SMTP_PORT=1025` over whatever the recipe exports.
- **Unmanaged detection over-reports** (optional OAuth secrets, `*_API_KEY` of internal services). Combined with exit code 3 by default, users of repos with optional integrations will have to pass `--allow-unmanaged` even when nothing is actually needed. That is the conservative failure mode the spec asks for; RESULTS.md reports how often it fired on real repos.
- **Scratchpad accident:** the subagent overwrote another agent's scratch copy of the fixture (same commit, same content). No lasting effect found.

## What was not tested

- That `run` accepts the generated config for real repos (the umami and rallly onboarding agents wrote their configs by hand in parallel; comparing them with `init` output is in the SCOUT_LOG).
- Yarn and bun repos; monorepos where Playwright lives in a package that is not a workspace member.
- Windows paths.

## What was assumed

- That `public/` is served at `/` (true for Express static and Next.js).
- That the repo's Playwright can be resolved from the config's directory (true when dependencies are installed).

## Lead's run (main tree, after wiring the hooks, 09:49-09:51 UTC)

- `just e2e-one f2-init`: pass (33.7 s): `init` on a clean fixture copy writes a config that `run --workers 2` accepts; with `ioredis` + `REDIS_URL` it exits non-zero, names Redis and `--allow-unmanaged`, writes no file; with the flag it writes the config listing redis.
- `just e2e-one f3-app` and `f6-report` still pass after the `app.start` placeholder and report-schema changes.
- Verdict: accepted.
