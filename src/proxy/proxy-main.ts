import http from 'node:http';
import { Router } from './forward.js';
import { listenOnHost } from './listen.js';
import { parseSharedOrigin } from './origin.js';
import type { ProxyMessage, ProxyRequest } from './protocol.js';

/** Writes one timestamped line to the proxy log (this process's stdout). */
function say(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

/** Sends a message to the CLI over the IPC channel and resolves once it is written. */
function send(message: ProxyMessage): Promise<void> {
  return new Promise((resolve) => process.send!(message, () => resolve()));
}

/** Carries out one request from the CLI and returns the reply. */
function answer(router: Router, request: ProxyRequest): ProxyMessage {
  switch (request.type) {
    case 'route':
      router.route(request.worker, request.port);
      return { type: 'reply', id: request.id, counts: null };
    case 'unroute':
      router.unroute(request.worker);
      return { type: 'reply', id: request.id, counts: null };
    case 'take':
      return { type: 'reply', id: request.id, counts: router.take() };
  }
}

/**
 * Entry point of the shared-origin proxy process: `node proxy-main.js <origin>`, started by proxy.ts with an IPC
 * channel. It listens on the origin's host and port, reports `listening` or `failed`, then serves route, unroute and
 * take requests from the CLI. It exits when the CLI disconnects, as well as on the SIGTERM of a normal teardown.
 */
async function main(originArg: string): Promise<void> {
  const origin = parseSharedOrigin(originArg);
  const router = new Router(say);
  const makeServer = () => http.createServer(router.handleRequest).on('upgrade', router.handleUpgrade);
  let addresses: string[];
  try {
    addresses = await listenOnHost(makeServer, origin.hostname, origin.port);
  } catch (error) {
    await send({ type: 'failed', message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
  process.on('message', (request: ProxyRequest) => void send(answer(router, request)));
  process.on('disconnect', () => process.exit(0));
  say(`listening for ${origin.href} on ${addresses.join(', ')}`);
  await send({ type: 'listening', addresses });
}

const [origin] = process.argv.slice(2);
if (origin === undefined || process.send === undefined) throw new Error('usage: proxy-main.js <origin>, started with an IPC channel');
await main(origin);
