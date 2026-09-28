import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { killGroup, RUN_ID_ENV } from '../proc/group.js';
import type { Reaper } from '../proc/reaper.js';
import { readTail } from '../proc/tail.js';
import type { SharedOrigin } from './origin.js';
import type { ProxyCounts, ProxyMessage, ProxyRequest } from './protocol.js';

const MAIN = fileURLToPath(new URL('./proxy-main.js', import.meta.url));

/** The running shared-origin proxy process (DECISIONS D-014). */
export interface OriginProxy {
  origin: SharedOrigin;
  /** Sends requests whose x-isolate-worker header is `index` to the app on 127.0.0.1:`port`. */
  route(index: number, port: number): Promise<void>;
  /** Stops routing `index`; its requests are refused from then on. */
  unroute(index: number): Promise<void>;
  /** Returns what the proxy counted since the previous take (or since it started), and starts counting afresh. */
  take(): Promise<ProxyCounts>;
  /** Stops the proxy's process group. */
  stop(): Promise<void>;
}

/** A request to the proxy before it gets its id. */
type Call = ProxyRequest extends infer R ? (R extends ProxyRequest ? Omit<R, 'id'> : never) : never;

/** Describes how a child process ended. */
function describeEnd(code: number | null, signal: NodeJS.Signals | null): string {
  return signal === null ? `exit code ${code}` : `signal ${signal}`;
}

/** Resolves with the proxy's first message, `listening` or `failed`; an exit before either counts as `failed`. */
function firstMessage(child: ChildProcess, logFile: string): Promise<ProxyMessage> {
  return new Promise((resolve) => {
    child.once('message', (message) => resolve(message as ProxyMessage));
    child.once('exit', (code, signal) =>
      resolve({ type: 'failed', message: `the shared-origin proxy exited (${describeEnd(code, signal)}) before listening:\n${readTail(logFile)}` }),
    );
  });
}

/**
 * Starts the shared-origin proxy as its own process group, stamped with the run ID and tracked by the reaper like the
 * apps (DECISIONS D-007), and resolves once it listens on the origin's host and port. Throws the proxy's own message
 * otherwise, for example when the port is taken.
 */
export async function startProxy(origin: SharedOrigin, reaper: Reaper, logFile: string): Promise<OriginProxy> {
  const fd = openSync(logFile, 'w');
  const child = spawn(process.execPath, [MAIN, origin.href], {
    detached: true,
    stdio: ['ignore', fd, fd, 'ipc'],
    env: { ...process.env, [RUN_ID_ENV]: reaper.runId },
  });
  closeSync(fd);
  const { pid } = child;
  if (pid === undefined) throw new Error('could not start the shared-origin proxy process');
  reaper.trackGroup(pid);
  const pending = new Map<number, { resolve: (counts: ProxyCounts | null) => void; reject: (error: Error) => void }>();
  let ended: string | null = null;
  child.once('exit', (code, signal) => {
    reaper.untrackGroup(pid);
    ended = `the shared-origin proxy exited (${describeEnd(code, signal)}); see ${logFile}`;
    for (const call of pending.values()) call.reject(new Error(ended));
    pending.clear();
  });

  const first = await firstMessage(child, logFile);
  if (first.type !== 'listening') {
    await killGroup(pid);
    throw new Error(first.type === 'failed' ? first.message : `unexpected first message from the shared-origin proxy: ${first.type}`);
  }
  child.on('message', (message: ProxyMessage) => {
    if (message.type !== 'reply') return;
    pending.get(message.id)?.resolve(message.counts);
    pending.delete(message.id);
  });

  let nextId = 0;
  const call = (request: Call) =>
    new Promise<ProxyCounts | null>((resolve, reject) => {
      if (ended !== null) {
        reject(new Error(ended));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.send({ ...request, id });
    });
  return {
    origin,
    route: async (index, port) => void (await call({ type: 'route', worker: String(index), port })),
    unroute: async (index) => void (await call({ type: 'unroute', worker: String(index) })),
    take: async () => (await call({ type: 'take' }))!,
    stop: () => killGroup(pid),
  };
}
