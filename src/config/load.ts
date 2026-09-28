import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { configSchema, type IsolateConfig } from './schema.js';

/** Name of the config file isolate reads from the repository root. */
export const CONFIG_FILE = 'isolate.config.ts';

/** Loads and validates `isolate.config.ts` from a repository directory. */
export async function loadConfig(repoDir: string): Promise<IsolateConfig> {
  const file = path.join(repoDir, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new Error(`No ${CONFIG_FILE} in ${repoDir}. Run \`isolate init\` first.`);
  }
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  const parsed = configSchema.safeParse(mod.default);
  if (!parsed.success) {
    throw new Error(`Invalid ${CONFIG_FILE}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
