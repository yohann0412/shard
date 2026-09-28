import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { execaSync } from 'execa';

/** The machine and tool versions a run's timings were measured on. */
export interface Machine {
  cpuModel: string;
  cores: number;
  threadsPerCore: number | null;
  ramGb: number;
  os: string;
  node: string;
  postgres: string;
  playwright: string | null;
  /** 1-minute load average when the run started; timed runs above 1.0 are redone (PLAN §8, rule 6). */
  loadAvg1: number;
}

/** Threads per physical core from lscpu (Linux only), or null. */
function threadsPerCore(): number | null {
  if (process.platform !== 'linux') return null;
  const result = execaSync('lscpu', { reject: false });
  const match = /^Thread\(s\) per core:\s*(\d+)/m.exec(String(result.stdout ?? ''));
  return match ? Number(match[1]) : null;
}

/** Version of the Playwright test runner the repo resolves from `dir`, or null if it cannot be found. */
function playwrightVersion(dir: string): string | null {
  const require = createRequire(path.join(dir, 'package.json'));
  for (const name of ['@playwright/test/package.json', 'playwright/package.json']) {
    try {
      return (JSON.parse(readFileSync(require.resolve(name), 'utf8')) as { version: string }).version;
    } catch {
      continue;
    }
  }
  return null;
}

/** Describes this machine, the Postgres version in use, the Playwright version the repo at `playwrightDir` uses, and the load at start. */
export function describeMachine(postgres: string, playwrightDir: string, loadAvg1: number): Machine {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    cores: cpus.length,
    threadsPerCore: threadsPerCore(),
    ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    postgres,
    playwright: playwrightVersion(playwrightDir),
    loadAvg1,
  };
}
