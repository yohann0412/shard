import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { WORKER_HEADER, type ProxyCounts } from './protocol.js';

/** Headers that describe one connection, not the message, so a proxy does not forward them (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer', 'proxy-authenticate', 'proxy-authorization']);

/** Where one request goes: the header value it carried and the app port that value is routed to. */
interface Target {
  worker: string;
  port: number;
}

/** Why a request cannot be routed; sent as the body of the 421 answer. */
interface Refusal {
  refusal: string;
}

/** Raw headers (name, value, name, value...) without hop-by-hop headers and those the Connection header names. */
function endToEnd(raw: string[]): string[] {
  const named = new Set<string>();
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === 'connection') for (const token of raw[i + 1]!.split(',')) named.add(token.trim().toLowerCase());
  }
  const kept: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (!HOP_BY_HOP.has(name) && !named.has(name)) kept.push(raw[i]!, raw[i + 1]!);
  }
  return kept;
}

/** The request line and headers of an upgrade request, exactly as received, to replay to the app. */
function upgradePreamble(req: http.IncomingMessage): string {
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * Forwards each request to the app its `x-isolate-worker` header names, over 127.0.0.1, and counts requests per header
 * value and app port. Requests without a routable header are answered 421 and counted as refused.
 */
export class Router {
  private readonly routes = new Map<string, number>();
  private routed = new Map<string, Map<number, number>>();
  private refused = 0;
  private readonly agent = new http.Agent({ keepAlive: true });

  constructor(private readonly say: (line: string) => void) {}

  /** Routes requests whose header value is `worker` to 127.0.0.1:`port`. */
  route(worker: string, port: number): void {
    this.routes.set(worker, port);
    this.say(`route ${WORKER_HEADER}: ${worker} -> 127.0.0.1:${port}`);
  }

  /** Stops routing `worker`; its requests are refused from now on. */
  unroute(worker: string): void {
    this.routes.delete(worker);
    this.say(`unroute ${WORKER_HEADER}: ${worker}`);
  }

  /** Returns the counts since the previous take and starts new ones. */
  take(): ProxyCounts {
    const routed = [...this.routed].flatMap(([worker, ports]) => [...ports].map(([port, requests]) => ({ worker, port, requests })));
    const counts = { routed, refused: this.refused };
    this.routed = new Map();
    this.refused = 0;
    return counts;
  }

  /** Handles one HTTP request (the `request` event of every listening server). */
  readonly handleRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const target = this.target(req);
    if ('refusal' in target) {
      res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' }).end(`${target.refusal}\n`);
      return;
    }
    const upstream = http.request(
      { host: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers: endToEnd(req.rawHeaders), agent: this.agent },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.statusMessage, endToEnd(response.rawHeaders));
        response.on('error', () => res.destroy());
        response.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (res.destroyed) return;
      this.say(`${req.method} ${req.url} for ${WORKER_HEADER}: ${target.worker}: app on port ${target.port} failed: ${error.message}`);
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`isolate proxy: the app on port ${target.port} failed: ${error.message}\n`);
    });
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  };

  /** Handles one upgrade request (WebSocket): replays it to the app, then pipes both sockets. */
  readonly handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const target = this.target(req);
    if ('refusal' in target) {
      socket.end(`HTTP/1.1 421 Misdirected Request\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n${target.refusal}\n`);
      return;
    }
    const upstream = net.connect(target.port, '127.0.0.1', () => {
      upstream.write(upgradePreamble(req));
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', (error) => {
      this.say(`upgrade ${req.url} for ${WORKER_HEADER}: ${target.worker}: app on port ${target.port} failed: ${error.message}`);
      socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  };

  /** Picks the app for a request and counts it, or counts and logs the refusal. */
  private target(req: http.IncomingMessage): Target | Refusal {
    const worker = req.headers[WORKER_HEADER];
    const port = typeof worker === 'string' ? this.routes.get(worker) : undefined;
    if (typeof worker !== 'string' || port === undefined) {
      this.refused++;
      const why = typeof worker === 'string' ? `${WORKER_HEADER}: ${worker} names no running app` : `the request has no ${WORKER_HEADER} header`;
      this.say(`421 ${req.method} ${req.url}: ${why}`);
      return {
        refusal: `isolate shared-origin proxy: ${why}, so it cannot be routed to a worker's app (Playwright adds the header to its pages and request contexts; other clients are refused).`,
      };
    }
    const ports = this.routed.get(worker) ?? new Map<number, number>();
    ports.set(port, (ports.get(port) ?? 0) + 1);
    this.routed.set(worker, ports);
    return { worker, port };
  }
}
