import type { EnvEntry } from '../env-files.js';

/** A variable that holds the app's own URL, templated to each worker's URL. */
export interface SelfUrl {
  key: string;
  /** The committed value, e.g. `http://localhost:3000/api/auth`. */
  original: string;
  /** The value with the app's origin replaced by `{url}`. */
  value: string;
  file: string;
}

/** Self-URL variables of the app, split by when the app reads them. */
export interface SelfUrls {
  runtime: SelfUrl[];
  /** Baked into the client bundle at build time, so they cannot differ per worker (RISKS R11). */
  buildTime: SelfUrl[];
}

const SELF_URL_NAMES = /^(NEXTAUTH_URL|AUTH_URL|BETTER_AUTH_URL|APP_URL|SITE_URL|ORIGIN|PUBLIC_URL|WEBAPP_URL|BASE_URL|NEXT_PUBLIC_\w*URL)$/;
/** Prefixes of variables that bundlers inline into client code at build time. */
export const BUILD_TIME_PREFIX = /^(NEXT_PUBLIC_|VITE_|REACT_APP_)/;

const LOCAL_URL = /^http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?(\/\S*)?$/;

/**
 * Committed dotenv keys whose value is `http://localhost:<app port>` (or, when the port is unknown, a well-known
 * self-URL name such as NEXTAUTH_URL): runtime ones are templated to `{url}`, build-time ones are reported.
 */
export function detectSelfUrls(env: EnvEntry[], port: number | null): SelfUrls {
  const runtime: SelfUrl[] = [];
  const buildTime: SelfUrl[] = [];
  const seen = new Set<string>();
  for (const entry of env) {
    const match = LOCAL_URL.exec(entry.value);
    if (match === null || seen.has(entry.key)) continue;
    const urlPort = match[1] === undefined ? 80 : Number(match[1]);
    if (port !== null ? urlPort !== port : !SELF_URL_NAMES.test(entry.key)) continue;
    seen.add(entry.key);
    const urlPath = match[2] === undefined || match[2] === '/' ? '' : match[2];
    const selfUrl = { key: entry.key, original: entry.value, value: `{url}${urlPath}`, file: entry.file };
    (BUILD_TIME_PREFIX.test(entry.key) ? buildTime : runtime).push(selfUrl);
  }
  return { runtime, buildTime };
}
