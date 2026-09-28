import type { Detection, Note } from './detect.js';
import { renderInline } from './render.js';
import type { UnmanagedService } from './unmanaged.js';

/** Values longer than this are shortened in the report; the config file has them in full. */
const MAX_VALUE = 100;

/** A note's value for humans: strings as they are, string lists comma-separated, long objects as their keys. */
function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) return value.join(', ');
  const literal = renderInline(value);
  if (literal.length <= MAX_VALUE || value === null || typeof value !== 'object' || Array.isArray(value)) return literal;
  const keys = Object.keys(value);
  return `${keys.length} variables: ${keys.join(', ')}`;
}

/** An aligned `key  value  (source)` block. */
function formatNotes(title: string, notes: Note[]): string {
  if (notes.length === 0) return '';
  const width = Math.max(...notes.map((note) => note.key.length));
  const lines = notes.map((note) => `  ${note.key.padEnd(width)}  ${displayValue(note.value)}  (${note.source})`);
  return `${title}\n${lines.join('\n')}\n\n`;
}

/** The init report: what was detected and from where, what was guessed, warnings and blocking problems. */
export function formatReport(repoDir: string, detection: Detection): string {
  const detected = detection.notes.filter((note) => !note.guessed);
  const guessed = detection.notes.filter((note) => note.guessed);
  const warnings = detection.warnings.map((warning) => `  - ${warning}`).join('\n');
  const problems = detection.problems.map((problem) => `  - ${problem}`).join('\n');
  return [
    `isolate init in ${repoDir}\n\n`,
    formatNotes('Detected:', detected),
    formatNotes('Guessed (not found in the repo; check these):', guessed),
    warnings === '' ? '' : `Warnings:\n${warnings}\n\n`,
    problems === '' ? '' : `Cannot write a config:\n${problems}\n\n`,
  ].join('');
}

/** The unmanaged services with their evidence. */
export function formatUnmanaged(services: UnmanagedService[]): string {
  const blocks = services.map((s) => `  ${s.service} (${s.kind})\n${s.evidence.map((line) => `    - ${line}`).join('\n')}`);
  return `Unmanaged services (isolate V1 starts and copies only Postgres and the app, D-012):\n${blocks.join('\n')}\n\n`;
}

/** Why init refuses to write a config when unmanaged services were found without --allow-unmanaged. */
export const UNMANAGED_REFUSAL = `isolate V1 does not isolate the services above: it gives each worker its own app and Postgres database only.
Re-run with --allow-unmanaged to write the config anyway. All N apps then share one real instance of each
service, so queues, caches, mailboxes and rate limits can leak between workers, and every run report lists them.
No config written.
`;
