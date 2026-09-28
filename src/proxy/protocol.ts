/** Header that names the app a request belongs to; the wrapper config adds it to every Playwright request. */
export const WORKER_HEADER = 'x-isolate-worker';

/** Requests the proxy forwarded for one `x-isolate-worker` value to one app port. */
export interface RoutedCount {
  worker: string;
  port: number;
  requests: number;
}

/** What the proxy counted between two takes. */
export interface ProxyCounts {
  routed: RoutedCount[];
  /** Requests answered 421 because their header was missing or named no app. */
  refused: number;
}

/** A message from the CLI to the proxy process; each one is answered by a `reply` with the same id. */
export type ProxyRequest =
  | { id: number; type: 'route'; worker: string; port: number }
  | { id: number; type: 'unroute'; worker: string }
  | { id: number; type: 'take' };

/** A message from the proxy process to the CLI. */
export type ProxyMessage =
  | { type: 'listening'; addresses: string[] }
  | { type: 'failed'; message: string }
  | { type: 'reply'; id: number; counts: ProxyCounts | null };
