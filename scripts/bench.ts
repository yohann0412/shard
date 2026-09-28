/**
 * `just bench`: runs `isolate run` many times at each worker count, alternating the order,
 * and prints the average wall time per worker count and the speedup over the smallest one.
 *
 * Usage: node dist/scripts/bench.js [--runs 20] [--workers 1,4] [--dir examples/fixture-app] [-- command...]
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

interface Sample {
  workers: number;
  round: number;
  exitCode: number;
  wallMs: number;
  testsMs: number;
  passed: number;
  failed: number;
}

interface Report {
  wallMs: number;
  phases: { tests?: number };
  tests: { passed: number; failed: number };
}

function parseArgs(argv: string[]): { runs: number; workers: number[]; dir: string; command: string[] } {
  const dashDash = argv.indexOf('--');
  const flags = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const command = dashDash === -1 ? ['npx', 'playwright', 'test'] : argv.slice(dashDash + 1);
  const value = (name: string, fallback: string): string => {
    const at = flags.indexOf(name);
    return at === -1 ? fallback : (flags[at + 1] ?? fallback);
  };
  const runs = Number(value('--runs', '20'));
  const workers = value('--workers', '1,4').split(',').map(Number);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, got ${value('--runs', '')}`);
  if (workers.some((n) => !Number.isInteger(n) || n < 1)) throw new Error(`--workers must be a comma-separated list of positive integers`);
  if (command.length === 0) throw new Error('empty command after --');
  return { runs, workers, dir: resolve(value('--dir', 'examples/fixture-app')), command };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

async function main(): Promise<number> {
  const { runs, workers, dir, command } = parseArgs(process.argv.slice(2));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const outDir = join(dir, '.isolate', 'bench', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outDir, { recursive: true });

  console.log(`bench: ${runs} rounds × workers [${workers.join(', ')}] in ${dir}`);
  console.log(`bench: command ${command.join(' ')}; raw logs and reports in ${outDir}`);
  console.log(`bench: ${cpus().length} cores; close other apps for steadier numbers\n`);

  const samples: Sample[] = [];
  for (let round = 1; round <= runs; round++) {
    // Rotate the order each round so neither worker count always runs first (warm caches, thermal throttling).
    const order = workers.map((_, i) => workers[(i + round - 1) % workers.length]!);
    for (const n of order) {
      const name = `r${String(round).padStart(2, '0')}-w${n}`;
      const result = await execa('node', [cli, 'run', '--workers', String(n), '--', ...command], {
        cwd: dir,
        reject: false,
        all: true,
      });
      writeFileSync(join(outDir, `${name}.log`), result.all ?? '');
      let report: Report;
      try {
        copyFileSync(join(dir, '.isolate', 'report.json'), join(outDir, `${name}.report.json`));
        report = JSON.parse(readFileSync(join(outDir, `${name}.report.json`), 'utf8')) as Report;
      } catch {
        console.log(`round ${round}/${runs}  workers ${n}: no report (exit ${result.exitCode}); see ${name}.log`);
        continue;
      }
      const sample: Sample = {
        workers: n,
        round,
        exitCode: result.exitCode ?? -1,
        wallMs: report.wallMs,
        testsMs: report.phases.tests ?? 0,
        passed: report.tests.passed,
        failed: report.tests.failed,
      };
      samples.push(sample);
      const status = sample.failed > 0 ? `  ${sample.failed} FAILED` : '';
      console.log(`round ${round}/${runs}  workers ${n}: wall ${seconds(sample.wallMs)}  (${sample.passed} passed${status})  load ${loadavg()[0]!.toFixed(2)}`);
    }
  }

  const lines: string[] = [];
  lines.push(`workers   runs   mean wall   median wall   stdev    min      max      mean tests phase   runs with failures`);
  const byWorkers = new Map<number, Sample[]>();
  for (const n of workers) byWorkers.set(n, samples.filter((s) => s.workers === n));
  for (const [n, group] of byWorkers) {
    if (group.length === 0) {
      lines.push(`${String(n).padEnd(9)} 0      (no successful runs)`);
      continue;
    }
    const walls = group.map((s) => s.wallMs);
    lines.push(
      [
        String(n).padEnd(9),
        String(group.length).padEnd(6),
        seconds(mean(walls)).padEnd(11),
        seconds(median(walls)).padEnd(13),
        seconds(stdev(walls)).padEnd(8),
        seconds(Math.min(...walls)).padEnd(8),
        seconds(Math.max(...walls)).padEnd(8),
        seconds(mean(group.map((s) => s.testsMs))).padEnd(18),
        String(group.filter((s) => s.failed > 0).length),
      ].join(' '),
    );
  }

  const base = Math.min(...workers);
  const baseWalls = (byWorkers.get(base) ?? []).map((s) => s.wallMs);
  if (baseWalls.length > 0) {
    lines.push('');
    for (const n of workers) {
      if (n === base) continue;
      const walls = (byWorkers.get(n) ?? []).map((s) => s.wallMs);
      if (walls.length === 0) continue;
      lines.push(
        `speedup ${n} vs ${base} worker(s): ${(mean(baseWalls) / mean(walls)).toFixed(2)}x by mean, ${(median(baseWalls) / median(walls)).toFixed(2)}x by median`,
      );
    }
  }

  const summary = lines.join('\n');
  console.log(`\n${summary}`);
  writeFileSync(join(outDir, 'summary.txt'), `${summary}\n`);
  writeFileSync(join(outDir, 'samples.json'), `${JSON.stringify(samples, null, 2)}\n`);
  console.log(`\nbench: summary saved to ${join(outDir, 'summary.txt')}`);
  return samples.some((s) => s.failed > 0) ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
