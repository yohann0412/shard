import { WORKER_HEADER } from '../proxy/protocol.js';
import type { ProxiedRequests } from './requests.js';

/** What isolate observed for one worker that ran tests (in baseline mode, for the one database b0). */
export interface WorkerEvidence {
  /** The worker's database, which also names its app: w0, w1, ... (b0 in baseline mode). */
  name: string;
  xactCommitDelta: number;
  /** Requests the shared-origin proxy forwarded to the worker's app during the tests; null without a proxy. */
  proxied: number | null;
  /** Bytes the worker's app wrote to its log during the tests; null when there is no app (baseline mode). */
  logBytes: number | null;
}

/** Everything the routing verdict is based on. */
export interface RoutingEvidence {
  /** The workers that ran tests, or null when Playwright wrote no per-test results. */
  used: WorkerEvidence[] | null;
  /** Proxied requests that reached an app other than the one their header names. */
  misrouted: ProxiedRequests[];
  /** The database URL variable (`db.urlEnv`), for messages. */
  urlEnv: string;
}

/** Valid, invalid, or null when it cannot be known; `errors` say what made it invalid, `warnings` what else to know. */
export interface RoutingVerdict {
  valid: boolean | null;
  errors: string[];
  warnings: string[];
}

/** Joins worker names, e.g. `w0, w2`. */
function names(workers: WorkerEvidence[]): string {
  return workers.map((worker) => worker.name).join(', ');
}

/**
 * Errors for used databases without commits whose apps have no request counts (normal mode). An app that wrote to its
 * log probably served the tests, which then made no queries; only a silent one points at an ignored database URL.
 */
function idleErrors(idle: WorkerEvidence[], urlEnv: string): string[] {
  const errors: string[] = [];
  const logged = idle.filter((worker) => (worker.logBytes ?? 0) > 0);
  const silent = idle.filter((worker) => (worker.logBytes ?? 0) <= 0);
  if (logged.length > 0) {
    errors.push(
      `routing check failed: no committed transactions on ${names(logged)}, although tests ran against it. Its app wrote to its log ` +
        'during the tests, so it probably served them and those tests make no database queries; without per-app request counts ' +
        '(--shared-origin has them) isolate cannot confirm that the app uses its own database.',
    );
  }
  if (silent.length > 0) {
    errors.push(
      `routing check failed: no committed transactions on ${names(silent)}, although tests ran against it. ` +
        `The app probably ignores ${urlEnv} (for example, a .env file overrides it), so workers shared a database (RISKS R3).`,
    );
  }
  return errors;
}

/**
 * Decides whether each worker reached its own app and database. Unknown without per-test results. Invalid when the
 * proxy misrouted a request or forwarded none for a worker that ran tests, or when a used database saw no commits: in
 * shared-origin mode only if no used database committed anything (an app that served proxied requests without
 * queries is a warning), otherwise always, worded by what the app's log shows (RISKS R1, R3; DECISIONS D-014).
 */
export function routingVerdict(evidence: RoutingEvidence): RoutingVerdict {
  const errors = evidence.misrouted.map(
    (record) =>
      `routing check failed: the shared-origin proxy sent ${record.requests} request(s) marked ${WORKER_HEADER}: ${record.worker} ` +
      `to ${record.app === null ? 'a port of no app' : `app w${record.app}`}`,
  );
  const used = evidence.used ?? [];
  if (used.length === 0) {
    const unknown = 'routing unknown: Playwright wrote no per-test results (for example, it was interrupted) or ran no test, so no worker could be checked';
    return { valid: errors.length > 0 ? false : null, errors, warnings: [unknown] };
  }
  const warnings: string[] = [];
  const unreached = used.filter((worker) => worker.proxied === 0);
  if (unreached.length > 0) {
    errors.push(`routing check failed: tests ran on ${names(unreached)}, but the shared-origin proxy forwarded no request to its app`);
  }
  const idle = used.filter((worker) => worker.xactCommitDelta <= 0 && worker.proxied !== 0);
  const served = idle.filter((worker) => worker.proxied !== null);
  if (served.length > 0 && used.every((worker) => worker.xactCommitDelta <= 0)) {
    const total = served.reduce((sum, worker) => sum + worker.proxied!, 0);
    errors.push(
      `routing check failed: no used worker database committed a transaction (${names(used)}), although the shared-origin proxy ` +
        `forwarded ${total} request(s) to their apps. Either the apps use another database (for example, a .env file overrides ` +
        `${evidence.urlEnv}; RISKS R3), or these tests make no database queries at all.`,
    );
  } else {
    for (const worker of served) {
      warnings.push(
        `no committed transactions on ${worker.name}, but the shared-origin proxy forwarded ${worker.proxied} request(s) to its app ` +
          'during the tests: the tests on that worker made no database queries (not a routing failure)',
      );
    }
  }
  errors.push(...idleErrors(idle.filter((worker) => worker.proxied === null), evidence.urlEnv));
  return { valid: errors.length === 0, errors, warnings };
}
