import type { Report } from './schema.js';

/** Formats milliseconds with one decimal and a thousands separator. */
function formatMs(ms: number): string {
  return ms.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Lays out rows as left-aligned first column and right-aligned other columns. */
function columns(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join('   '));
}

/** The phases with their share of the wall time. */
function phaseLines(report: Report): string[] {
  const rows = Object.entries(report.phases).map(([name, ms]) => [name, formatMs(ms), `${((100 * ms) / report.wallMs).toFixed(1)}%`]);
  return columns([['phase', 'ms', '% wall'], ...rows, ['wall', formatMs(report.wallMs), '100.0%']]);
}

/** Test counts per Playwright worker. */
function workerLines(report: Report): string[] {
  if (report.workers.length === 0) return [];
  const rows = report.workers.map((worker) => [`worker ${worker.parallelIndex}`, String(worker.tests), String(worker.passed), String(worker.failed)]);
  return ['', ...columns([['', 'tests', 'passed', 'failed'], ...rows])];
}

/** Playwright's own timing and concurrency. */
function playwrightLines(report: Report): string[] {
  const pw = report.playwright;
  if (pw === null) return ['playwright: no results (Playwright exited before its reporters finished)'];
  return [
    `playwright: test phase ${formatMs(pw.testPhaseMs)} ms, before first test ${formatMs(pw.preTestMs)} ms, after last test ${formatMs(pw.postTestMs)} ms`,
    `            ${pw.resolvedWorkers} workers resolved, ${pw.maxConcurrent} tests at most at once, parallel indexes [${pw.parallelIndexes.join(', ')}]`,
    `            in hooks and fixtures ${formatMs(pw.setupMs)} ms, in test bodies ${formatMs(pw.bodyMs)} ms`,
  ];
}

/** Failed tests with their classification. */
function failureLines(report: Report): string[] {
  if (report.failures.length === 0) return [];
  return [
    'failures:',
    ...report.failures.map((failure) => {
      const reruns = failure.reruns.length > 0 ? ` (reruns: ${failure.reruns.join(', ')})` : '';
      return `  ${failure.classification.padEnd(13)} ${failure.id}${reruns}`;
    }),
  ];
}

/** The first line of every warning, so nothing printed before Playwright's output is missed. */
function warningLines(report: Report): string[] {
  if (report.warnings.length === 0) return [];
  return ['warnings:', ...report.warnings.map((warning) => `  ${warning.split('\n')[0]}`)];
}

/** Requests the shared-origin proxy forwarded to each app, and refused; nothing without a shared origin. */
function proxyLines(report: Report): string[] {
  if (report.proxy === null) return [];
  const apps = report.apps.map((app) => `w${app.index} ${app.requests ?? 0}`).join(', ');
  return [`proxy ${report.proxy.origin}: requests per app ${apps}; refused (421) ${report.proxy.refused}`];
}

/** The routing verdict in words. */
function routingLine(report: Report): string {
  if (report.routingValid === null) return 'routing: unknown (see warnings)';
  return `routing: ${report.routingValid ? 'valid' : 'INVALID (see warnings)'}`;
}

/** Peak resident memory of every app and of Postgres. */
function memoryLine(report: Report): string {
  const apps = report.apps.map((app) => `w${app.index} ${app.peakRssMb.toFixed(0)} MB`);
  return `peak RSS: ${[...apps, `postgres ${report.postgresPeakRssMb.toFixed(0)} MB`].join(', ')}`;
}

/** Renders the end-of-run summary table printed to stderr. */
export function renderTable(report: Report, reportFile: string): string {
  const { total, passed, failed, flaky, skipped } = report.tests;
  const lines = [
    '',
    `isolate ${report.mode}: ${report.workerCount} worker(s), ${report.command.join(' ')}`,
    '',
    ...phaseLines(report),
    ...workerLines(report),
    '',
    `tests: ${total} total, ${passed} passed, ${failed} failed, ${flaky} flaky, ${skipped} skipped`,
    ...playwrightLines(report),
    ...failureLines(report),
    memoryLine(report),
    report.cpu === null ? 'cpu: not measured' : `cpu during tests: ${report.cpu.busyPct}% busy, ${report.cpu.stealPct}% steal`,
    ...proxyLines(report),
    routingLine(report),
    ...warningLines(report),
    `report: ${reportFile}`,
    '',
  ];
  return lines.join('\n');
}
