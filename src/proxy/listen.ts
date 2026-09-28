import { lookup } from 'node:dns/promises';
import type http from 'node:http';

/** Errors of an address family this machine does not have (such as ::1 without IPv6); those addresses are skipped. */
const UNAVAILABLE = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

/** Every address `hostname` resolves to; for `localhost` also both loopbacks, since browsers resolve it themselves. */
async function addressesOf(hostname: string): Promise<string[]> {
  const resolved = (await lookup(hostname, { all: true })).map((entry) => entry.address);
  return [...new Set([...resolved, ...(hostname === 'localhost' ? ['127.0.0.1', '::1'] : [])])];
}

/** Listens on one address; resolves with the error instead of throwing it. */
function listenOn(server: http.Server, address: string, port: number): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => resolve(error);
    server.once('error', onError);
    server.listen(port, address, () => {
      server.off('error', onError);
      resolve(null);
    });
  });
}

/** A message for the user about an address the proxy could not listen on. */
function listenError(error: NodeJS.ErrnoException, hostname: string, address: string, port: number): string {
  if (error.code === 'EADDRINUSE') {
    return (
      `port ${port} of ${hostname} is taken (${address}:${port} already has a listener), and the shared-origin proxy needs it. ` +
      'Stop whatever listens there (often the app itself, or a dev server started outside isolate), or pass another --shared-origin.'
    );
  }
  if (error.code === 'EACCES') return `not allowed to listen on ${address}:${port} (ports below 1024 need privileges); pass another --shared-origin`;
  return `cannot listen on ${address}:${port} for the shared origin: ${error.message}`;
}

/**
 * Listens on `port` of every address of `hostname`, one server each (made by `makeServer`), and returns the
 * `address:port` pairs. Throws a message for the user if the port is taken on any of them, or if none exists here.
 */
export async function listenOnHost(makeServer: () => http.Server, hostname: string, port: number): Promise<string[]> {
  const listening: string[] = [];
  for (const address of await addressesOf(hostname)) {
    const error = await listenOn(makeServer(), address, port);
    if (error === null) listening.push(address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`);
    else if (!UNAVAILABLE.has(error.code ?? '')) throw new Error(listenError(error, hostname, address, port));
  }
  if (listening.length === 0) throw new Error(`cannot listen on ${hostname}:${port}: none of its addresses exists on this machine`);
  return listening;
}
