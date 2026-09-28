import type { EnvEntry } from '../env-files.js';
import { readPackageJson } from '../files.js';
import { found, guess, type Finding } from '../finding.js';
import { scriptBody } from '../scripts.js';

/** The first `$X`, `${X}` or `process.env.X` in a command whose name ends in PORT. */
function portVariableIn(command: string): string | null {
  const match = /\$\{?([A-Za-z_]\w*PORT)\b|process\.env\.([A-Za-z_]\w*PORT)\b/.exec(command);
  return match ? (match[1] ?? match[2]!) : null;
}

/**
 * The variable the app reads its port from: one the start command or the script it runs names, else PORT or a
 * `*_PORT` key holding the app's port in a committed dotenv file, else PORT.
 */
export function detectPortEnv(appDir: string, start: string, env: EnvEntry[], port: number | null): Finding<string> {
  const lastStep = start.split('&&').at(-1)!.trim();
  const body = scriptBody(lastStep, readPackageJson(appDir));
  const fromCommand = portVariableIn(lastStep);
  if (fromCommand !== null) return found(fromCommand, 'app.start');
  const fromScript = body === null ? null : portVariableIn(body);
  if (fromScript !== null) return found(fromScript, `the script \`${lastStep}\` runs`);
  const entry = env.find((e) => e.key === 'PORT') ?? env.find((e) => e.key.endsWith('_PORT') && port !== null && e.value === String(port));
  if (entry !== undefined) return found(entry.key, entry.file);
  return guess('PORT', 'no port variable in the start command, its script or a committed .env file');
}
