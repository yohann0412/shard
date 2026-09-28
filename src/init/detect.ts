import path from 'node:path';
import type { z } from 'zod';
import type { configSchema } from '../config/schema.js';
import { detectBaseUrlEnvs } from './detect/base-url.js';
import { detectBuild } from './detect/build.js';
import { cacheInputs } from './detect/cache-inputs.js';
import { detectClientRoots } from './detect/client-roots.js';
import { configLoadedEnv, type ConfigEnv } from './detect/config-env.js';
import { detectDatabaseEnvs } from './detect/database.js';
import { detectHealthPath } from './detect/health-path.js';
import { detectMigrate } from './detect/migrate.js';
import { detectPackageManager } from './detect/package-manager.js';
import { findPlaywrightConfigs } from './detect/playwright-config.js';
import { detectPortEnv } from './detect/port-env.js';
import { findPrisma } from './detect/prisma.js';
import { detectSeed } from './detect/seed.js';
import { detectSelfUrls, type SelfUrls } from './detect/self-urls.js';
import { deriveStart } from './detect/start.js';
import { probeWebServers } from './detect/web-server.js';
import { envExampleEntries } from './env-files.js';
import { relPath } from './files.js';
import { found, type Finding } from './finding.js';
import { findWorkspace } from './workspace.js';

/** The config init writes, before schema defaults are applied. */
export type ConfigInput = z.input<typeof configSchema>;

/** One line of the init report: a config value and where it came from. */
export interface Note extends Finding<unknown> {
  /** Config key path, e.g. `app.healthPath`. */
  key: string;
}

/** What detection produced. */
export interface Detection {
  /** The config, or null if a required value was not found (then `problems` says which). */
  config: ConfigInput | null;
  notes: Note[];
  warnings: string[];
  problems: string[];
}

/** Where app.env's entries come from, lowest precedence first. */
interface AppEnvParts {
  configName: string;
  selfUrls: SelfUrls;
  configEnv: ConfigEnv;
  /** webServer.env's explicit entries. */
  serverEnv: Record<string, string>;
  /** Variables isolate sets itself (port and database URLs), left out of app.env. */
  managed: string[];
}

const MIGRATE_MISSING =
  'Could not find how to migrate the database: no Prisma schema, drizzle.config.*, knexfile.*, TypeORM/MikroORM ' +
  'migration script, or package.json script named migrate, db:migrate, migration:run or prisma:migrate. Add such a ' +
  'script (it must create the schema in the database named by the database URL variable) and run isolate init again.';

/** The Playwright config to use, and a warning if there are several. */
function choosePlaywrightConfig(repoDir: string): { configFile: string; warnings: string[] } {
  const [configFile, ...others] = findPlaywrightConfigs(repoDir);
  if (configFile === undefined) {
    throw new Error(`No playwright.config.{ts,js,mjs,cjs} in ${repoDir} or its e2e/, tests/, apps/*/ or packages/*/ directories.`);
  }
  const warnings = others.length === 0 ? [] : [`Using ${relPath(repoDir, configFile)}; also found ${others.map((file) => relPath(repoDir, file)).join(', ')}.`];
  return { configFile, warnings };
}

/**
 * app.env, from lowest to highest precedence: the app's own URL variables in committed dotenv files as `{url}`, the
 * committed values the Playwright config loads into the environment webServer inherits, and webServer.env's explicit
 * entries; minus the variables isolate sets itself. Build-time self URLs and uncommitted loaded values become warnings.
 */
function appEnvironment(parts: AppEnvParts): { env: Finding<Record<string, string>>; warnings: string[] } {
  const { configName, selfUrls, configEnv, serverEnv, managed } = parts;
  const pairs: Array<[string, string]> = [
    ...selfUrls.runtime.map((url): [string, string] => [url.key, url.value]),
    ...Object.entries(configEnv.committed),
    ...Object.entries(serverEnv),
  ];
  const sources = [
    ...selfUrls.runtime.map((url) => `${url.key} is the app's own URL in ${url.file}`),
    ...(configEnv.files.length > 0 ? [`values ${configName} loads from ${configEnv.files.join(', ')}`] : []),
    ...(Object.keys(serverEnv).length > 0 ? [`webServer.env in ${configName}`] : []),
  ];
  const warnings = selfUrls.buildTime.map(
    (url) =>
      `${url.key}=${url.original} (${url.file}) is the app's own URL, but it is baked into the client bundle at build time, ` +
      "so every worker's app keeps this one value (RISKS R11): client code that uses it talks to one app.",
  );
  if (configEnv.files.length > 0) {
    warnings.push(
      `app.env includes the values ${configName} loads from ${configEnv.files.join(', ')}. There they only fill unset ` +
        'variables; app.env overrides the environment, so delete any you set yourself (e.g. a local mail port).',
    );
  }
  if (configEnv.uncommitted.length > 0) {
    warnings.push(
      `${configName} loads ${configEnv.uncommitted.join(', ')} into the environment from outside the committed .env files ` +
        '(a local .env?). webServer inherits them, but isolate starts the apps itself: export the ones the app needs.',
    );
  }
  return { env: found(Object.fromEntries(pairs.filter(([key]) => !managed.includes(key))), sources.join('; ')), warnings };
}

/**
 * Inspects the repo in repoDir and derives isolate.config.ts: package manager, Playwright config and its resolved
 * webServer, database variables and steps, build, base-URL and self-URL variables, cache inputs and client roots.
 */
export async function detectConfig(repoDir: string): Promise<Detection> {
  const { configFile, warnings } = choosePlaywrightConfig(repoDir);
  const configName = relPath(repoDir, configFile);
  const workspace = findWorkspace(repoDir);
  const packageManager = detectPackageManager(repoDir, workspace.root);
  const notes: Note[] = [
    { key: 'packageManager', value: packageManager.value, source: packageManager.source, guessed: packageManager.guessed },
    { key: 'playwright.config', ...found(configName, 'first Playwright config found') },
  ];

  const probe = await probeWebServers(configFile);
  const app = deriveStart(repoDir, configFile, probe, packageManager.value);
  if (app === null) {
    return { config: null, notes, warnings, problems: [`${configName} has no webServer and there is no "start" script: isolate cannot tell how to start the app.`] };
  }
  warnings.push(...app.warnings);

  const dirs = [...new Set([app.appDir, repoDir, ...workspace.packageDirs])];
  const appEnvFiles = envExampleEntries(repoDir, [...new Set([app.appDir, path.dirname(configFile), repoDir])]);
  const prisma = findPrisma(dirs);
  const stepContext = { repoDir, appDir: app.appDir, dirs, packageManager: packageManager.value };
  const migrate = detectMigrate(stepContext, prisma);
  const seed = detectSeed(stepContext, prisma);
  const database = detectDatabaseEnvs(repoDir, prisma, appEnvFiles);
  const build = detectBuild(repoDir, app.appDir, packageManager.value, app.build);
  const baseUrl = detectBaseUrlEnvs(repoDir, configFile);
  const portEnv = detectPortEnv(app.appDir, app.start.value, appEnvFiles, app.port);
  const healthPath = detectHealthPath(repoDir, app.appDir, app.urlPath);
  const clientRoots = detectClientRoots(repoDir, app.appDir);
  const managed = [portEnv.value, database.urlEnv.value, ...database.extraUrlEnvs.value];
  const appEnv = appEnvironment({
    configName,
    selfUrls: detectSelfUrls(appEnvFiles, app.port),
    configEnv: configLoadedEnv(probe.addedEnv, appEnvFiles, app.port, managed),
    serverEnv: app.env,
    managed,
  });
  warnings.push(...appEnv.warnings);
  const inputs = cacheInputs(repoDir, {
    lockfile: packageManager.lockfile,
    packageDirs: [...new Set([repoDir, app.appDir, ...(prisma === null ? [] : [prisma.packageDir])])],
    stepInputs: [...(migrate?.inputs ?? []), ...(seed?.inputs ?? [])],
  });

  const isEmpty = (record: Record<string, string>) => Object.keys(record).length === 0;
  const findings: Array<[string, Finding<unknown> | null]> = [
    ['build.command', build?.command ?? found('(none)', 'no build step in webServer.command and no "build" script')],
    ['build.outputs', build?.outputs ?? null],
    ['db.migrate', migrate?.command ?? null],
    ['db.seed', seed?.command ?? found('(none)', 'no Prisma seed and no "seed" or "db:seed" script')],
    ['db.urlEnv', database.urlEnv],
    ['db.extraUrlEnvs', database.extraUrlEnvs],
    ['app.start', app.start],
    ['app.portEnv', portEnv],
    ['app.healthPath', healthPath],
    ['app.env', isEmpty(appEnv.env.value) ? null : appEnv.env],
    ['app.bootTimeoutMs', app.bootTimeoutMs === null ? null : found(app.bootTimeoutMs, 'webServer.timeout')],
    ['playwright.baseUrlEnvs', baseUrl.baseUrlEnvs],
    ['playwright.env', isEmpty(baseUrl.env) ? null : found(baseUrl.env, `port variables near baseURL in ${configName}`)],
    ['cache.inputs', found(inputs, 'lockfile, package.json, migration and seed inputs, isolate.config.ts')],
    ['trace.clientRoots', clientRoots],
  ];
  notes.push(...findings.flatMap(([key, finding]) => (finding === null ? [] : [{ key, ...finding }])));
  if (migrate === null) return { config: null, notes, warnings, problems: [MIGRATE_MISSING] };

  const config: ConfigInput = {
    packageManager: packageManager.value,
    ...(build === null ? {} : { build: { command: build.command.value, outputs: build.outputs.value } }),
    db: {
      migrate: migrate.command.value,
      ...(seed === null ? {} : { seed: seed.command.value }),
      urlEnv: database.urlEnv.value,
      extraUrlEnvs: database.extraUrlEnvs.value,
    },
    app: {
      start: app.start.value,
      portEnv: portEnv.value,
      healthPath: healthPath.value,
      env: appEnv.env.value,
      ...(app.bootTimeoutMs === null ? {} : { bootTimeoutMs: app.bootTimeoutMs }),
    },
    playwright: { config: configName, baseUrlEnvs: baseUrl.baseUrlEnvs.value, env: baseUrl.env },
    cache: { inputs },
    trace: { clientRoots: clientRoots.value },
  };
  return { config, notes, warnings, problems: [] };
}
