import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { reportSchema } from '../report/schema.js';

const USAGE = 'Usage: isolate report --check <report.json>\n';

/** `isolate report --check <file>`: validates a report against the schema, prints `ok` or the errors. */
export async function main(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { check: { type: 'string' } } });
  if (values.check === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (!existsSync(values.check)) {
    process.stderr.write(`No such file: ${values.check}\n`);
    return 1;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(values.check, 'utf8'));
  } catch (error) {
    process.stderr.write(`${values.check} is not valid JSON: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const parsed = reportSchema.safeParse(data);
  if (!parsed.success) {
    process.stderr.write(`${z.prettifyError(parsed.error)}\n`);
    return 1;
  }
  process.stdout.write('ok\n');
  return 0;
}
