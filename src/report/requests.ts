import type { RunningApp } from '../app/apps.js';
import type { ProxyCounts } from '../proxy/protocol.js';

/** Requests the shared-origin proxy forwarded during the tests for one x-isolate-worker value to one app. */
export interface ProxiedRequests {
  worker: string;
  /** Index of the app whose port received them, or null for a port that belongs to no app of the run. */
  app: number | null;
  requests: number;
}

/** What the shared-origin proxy saw during the tests, as the report records it. */
export interface ProxyReport {
  origin: string;
  requests: ProxiedRequests[];
  /** Requests answered 421: no x-isolate-worker header, or one that named no app. */
  refused: number;
}

/** Turns the proxy's counts per app port into counts per app index, ordered by worker and app. */
export function proxyReport(origin: string, counts: ProxyCounts, apps: RunningApp[]): ProxyReport {
  const requests = counts.routed
    .map(({ worker, port, requests }) => ({ worker, app: apps.find((app) => app.port === port)?.index ?? null, requests }))
    .sort((a, b) => Number(a.worker) - Number(b.worker) || (a.app ?? -1) - (b.app ?? -1));
  return { origin, requests, refused: counts.refused };
}

/** Requests the proxy forwarded to app `index`, whatever header they carried. */
export function requestsTo(report: ProxyReport, index: number): number {
  return report.requests.filter((record) => record.app === index).reduce((sum, record) => sum + record.requests, 0);
}

/** Proxied requests that reached an app other than the one their header names. */
export function misrouted(report: ProxyReport): ProxiedRequests[] {
  return report.requests.filter((record) => record.app === null || String(record.app) !== record.worker);
}
