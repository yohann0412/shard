import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from '../log.js';
import type { BeginRequest, ClientScript, EndRequest, ServerScript } from './protocol.js';
import { takeWorker } from './takes.js';

/** Everything recorded for one test, over all its attempts. */
export interface TracedTest {
  title: string;
  file: string;
  server: ServerScript[];
  client: ClientScript[];
}

/** What the controller recorded during a run: the input of the impact map. */
export interface TraceRecord {
  /** Every worker's first take: app start, health checks and anything else before that worker's first test. */
  boot: ServerScript[];
  tests: Map<string, TracedTest>;
  /** Client script sources that carry a source map comment, by URL. */
  sources: Map<string, string>;
  /** Takes between two tests of one worker that found executed code; it is attributed to the earlier test. */
  betweenTestTakes: number;
  /** Takes that went ahead while HTTP requests were still in flight after the app's wait limit. */
  takeTimeouts: number;
}

/** The control server that Playwright workers call before and after each test. */
export interface Controller {
  /** Base URL, passed to the workers as ISOLATE_CONTROL_URL. */
  url: string;
  record: TraceRecord;
  close(): Promise<void>;
}

class BadRequest extends Error {}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Checks the fields every hook call carries. */
function hookCall<T extends BeginRequest | EndRequest>(body: unknown): T {
  const call = body as Partial<T>;
  if (!Number.isInteger(call.worker) || typeof call.testId !== 'string') throw new BadRequest('worker (integer) and testId (string) are required');
  return call as T;
}

/**
 * Starts the control server on 127.0.0.1 (random port). POST /begin takes worker i's server coverage: the first take
 * of a worker is its boot window, later ones are between tests and go to that worker's previous test. POST /end takes
 * it again for the test that just ended and adds the client coverage the worker sends.
 */
export async function startController(traceDir: string): Promise<Controller> {
  const record: TraceRecord = { boot: [], tests: new Map(), sources: new Map(), betweenTestTakes: 0, takeTimeouts: 0 };
  /** Last test that began on each worker; a worker without an entry has not been taken yet. */
  const lastTest = new Map<number, string>();

  const take = async (worker: number): Promise<ServerScript[]> => {
    const replies = await takeWorker(traceDir, worker);
    record.takeTimeouts += replies.filter((reply) => reply.timedOut).length;
    return replies.flatMap((reply) => reply.scripts);
  };

  const begin = async ({ worker, testId, title, file }: BeginRequest): Promise<void> => {
    const scripts = await take(worker);
    const previous = lastTest.get(worker);
    if (previous === undefined) {
      record.boot.push(...scripts);
    } else if (scripts.length > 0) {
      record.betweenTestTakes++;
      record.tests.get(previous)?.server.push(...scripts);
    }
    lastTest.set(worker, testId);
    if (!record.tests.has(testId)) record.tests.set(testId, { title, file, server: [], client: [] });
  };

  const end = async ({ worker, testId, client }: EndRequest): Promise<void> => {
    const test = record.tests.get(testId);
    if (test === undefined) throw new BadRequest(`/end for ${testId} without /begin`);
    test.server.push(...(await take(worker)));
    for (const { url, functions, source } of client) {
      if (source !== undefined) record.sources.set(url, source);
      test.client.push({ url, functions });
    }
  };

  const handle = async (request: http.IncomingMessage): Promise<void> => {
    if (request.method === 'POST' && request.url === '/begin') return begin(hookCall<BeginRequest>(await readJson(request)));
    if (request.method === 'POST' && request.url === '/end') return end(hookCall<EndRequest>(await readJson(request)));
    throw new BadRequest(`unknown route ${request.method} ${request.url}`);
  };

  const server = http.createServer((request, response) => {
    handle(request).then(
      () => response.writeHead(204).end(),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`trace controller: ${request.url}: ${message}`);
        response.writeHead(error instanceof BadRequest || error instanceof SyntaxError ? 400 : 500).end(message);
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    record,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
