import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const POLL_MS = 2_000;

/** How long a run waited for ports another process held. */
export interface PortWait {
  ports: number[];
  waitedMs: number;
  /** False if some port was still taken when the wait gave up. */
  free: boolean;
}

/** True if something accepts TCP connections on `host:port` within one second. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1_000 });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** True if a server listens on `port` on localhost, over IPv4 or IPv6. */
async function portInUse(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([accepts('127.0.0.1', port), accepts('::1', port)]);
  return v4 || v6;
}

/** Waits, polling every 2 s for at most `maxWaitMs`, until no server listens on any of `ports`. */
export async function waitForFreePorts(ports: number[], maxWaitMs: number): Promise<PortWait> {
  const start = performance.now();
  const anyTaken = async () => (await Promise.all(ports.map(portInUse))).some(Boolean);
  let taken = await anyTaken();
  while (taken && performance.now() - start + POLL_MS <= maxWaitMs) {
    await sleep(POLL_MS);
    taken = await anyTaken();
  }
  return { ports, waitedMs: Math.round(performance.now() - start), free: !taken };
}
