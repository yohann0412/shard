import { existsSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { log } from '../log.js';
import type { TakeReply } from './protocol.js';

/** Upper bound for one take: the app waits up to 2 s for in-flight requests, then serializes its coverage. */
const TAKE_TIMEOUT_MS = 30_000;

/** Sends "take" to one app process's socket and parses the reply; null if the process is gone or the take failed. */
function takeOne(socketPath: string): Promise<TakeReply | null> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let received = '';
    socket.setEncoding('utf8');
    socket.setTimeout(TAKE_TIMEOUT_MS, () => socket.destroy(new Error(`no reply within ${TAKE_TIMEOUT_MS} ms`)));
    socket.on('connect', () => socket.write('take\n'));
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') log.warn(`coverage take from ${socketPath} failed: ${error.message}`);
      resolve(null);
    });
    socket.on('end', () => {
      try {
        const reply = JSON.parse(received) as TakeReply | { error: string };
        if (!('error' in reply)) return resolve(reply);
        log.warn(`coverage take from ${socketPath} failed in the app: ${reply.error}`);
      } catch (error) {
        log.warn(`coverage take from ${socketPath} sent unreadable JSON: ${String(error)}`);
      }
      resolve(null);
    });
  });
}

/**
 * Takes coverage from every process of worker i's app that has a socket in <traceDir>/w<i>/ right now (the directory
 * is listed on every call, since processes can start later). Each process returns what it executed since its last take.
 */
export async function takeWorker(traceDir: string, worker: number): Promise<TakeReply[]> {
  const dir = path.join(traceDir, `w${worker}`);
  const sockets = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.sock')) : [];
  const replies = await Promise.all(sockets.map((name) => takeOne(path.join(dir, name))));
  return replies.filter((reply) => reply !== null);
}
