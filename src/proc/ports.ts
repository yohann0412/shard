import { createServer, type Server } from 'node:net';

function listenOnFreePort(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Returns `count` distinct TCP ports that were free on 127.0.0.1 (all bound at once, then released). */
export async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(Array.from({ length: count }, () => listenOnFreePort()));
  const ports = servers.map((server) => {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('could not read the port of a probe socket');
    return address.port;
  });
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}
