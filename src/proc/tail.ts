import { existsSync, readFileSync } from 'node:fs';

/** Returns the last `lines` lines of a log file, or a note if the file does not exist. */
export function readTail(file: string, lines = 30): string {
  if (!existsSync(file)) return `(no log at ${file})`;
  return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
}
