import { readText, relPath } from '../files.js';
import { found, guess, type Finding } from '../finding.js';

/** The variables the Playwright config builds its baseURL from. */
export interface BaseUrlFinding {
  baseUrlEnvs: Finding<string[]>;
  /** Port variables the baseURL is built from, set to each worker's own app port in its test process. */
  env: Record<string, string>;
}

/** How many `const X = ...` hops are followed from the baseURL expression. */
const MAX_HOPS = 3;

/** The lines that set baseURL, each with the line after it, for values that wrap. */
function baseUrlLines(lines: string[]): string[] {
  return lines.flatMap((line, i) => (/\bbaseURL\b/.test(line) ? [`${line}\n${lines[i + 1] ?? ''}`] : []));
}

/** The initializer of `const|let|var <name> = ...` in the config text (rest of that line and the next), or null. */
function declaration(text: string, name: string): string | null {
  return new RegExp(String.raw`\b(?:const|let|var)\s+${name}\s*=\s*([^\n]*\n?[^\n]*)`).exec(text)?.[1] ?? null;
}

/** Every `process.env.X` or `process.env['X']` in an expression, following identifiers to their declarations. */
function envVarsIn(text: string, expression: string, hops: number, seen: Set<string>): string[] {
  const direct = [...expression.matchAll(/process\.env(?:\.(\w+)|\[\s*['"](\w+)['"]\s*\])/g)].map((m) => (m[1] ?? m[2])!);
  if (hops === 0) return direct;
  const identifiers = [...new Set(expression.match(/\b[A-Za-z_]\w*\b/g) ?? [])].filter((name) => !seen.has(name));
  for (const name of identifiers) seen.add(name);
  const followed = identifiers.flatMap((name) => {
    const init = declaration(text, name);
    return init === null ? [] : envVarsIn(text, init, hops - 1, seen);
  });
  return [...new Set([...direct, ...followed])];
}

/**
 * Scans the Playwright config text for the variables used in or near `baseURL`: URL-like ones become
 * playwright.baseUrlEnvs (default BASE_URL), port ones are set to each worker's port in playwright.env.
 */
export function detectBaseUrlEnvs(repoDir: string, configFile: string): BaseUrlFinding {
  const text = readText(configFile) ?? '';
  const seen = new Set(['process', 'env']);
  const vars = [...new Set(baseUrlLines(text.split('\n')).flatMap((expression) => envVarsIn(text, expression, MAX_HOPS, seen)))];
  const urlVars = vars.filter((name) => /URL|URI|ORIGIN/.test(name));
  const portVars = vars.filter((name) => /PORT$/.test(name));
  const configName = relPath(repoDir, configFile);
  const baseUrlEnvs =
    urlVars.length > 0 ? found(urlVars, `process.env near baseURL in ${configName}`) : guess(['BASE_URL'], `no URL variable near baseURL in ${configName}`);
  return { baseUrlEnvs, env: Object.fromEntries(portVars.map((name) => [name, '{port}'])) };
}
