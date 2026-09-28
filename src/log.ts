import { pino, type Logger } from 'pino';

const LEVEL_NAMES: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

/** Turns one pino JSON line into a short human-readable line. */
function formatLine(line: string): string {
  const { level, msg, ...fields } = JSON.parse(line) as { level: number; msg?: string } & Record<string, unknown>;
  const extras = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  const prefix = level >= 40 ? `[isolate] ${LEVEL_NAMES[level] ?? level}:` : '[isolate]';
  return `${prefix} ${msg ?? ''}${extras ? ` ${extras}` : ''}\n`;
}

/** Process-wide logger writing human-readable lines to stderr. */
export const log: Logger = pino(
  { level: process.env.ISOLATE_LOG_LEVEL ?? 'info', base: undefined, timestamp: false },
  { write: (line: string) => process.stderr.write(formatLine(line)) },
);
