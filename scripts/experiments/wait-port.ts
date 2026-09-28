import { waitForFreePorts } from './ports.js';
import { say } from './provenance.js';

const USAGE = 'Usage: node dist/scripts/experiments/wait-port.js <port> [max-seconds]\n';

/** Waits until nothing listens on a localhost port (default: at most 15 minutes) and says how long it waited. */
async function main(argv: string[]): Promise<number> {
  const port = Number(argv[0]);
  const maxSeconds = Number(argv[1] ?? 900);
  if (!Number.isInteger(port) || port < 1 || !Number.isFinite(maxSeconds)) {
    process.stderr.write(USAGE);
    return 2;
  }
  const wait = await waitForFreePorts([port], maxSeconds * 1000);
  const waited = `${(wait.waitedMs / 1000).toFixed(1)} s`;
  say(wait.free ? `port ${port} is free (waited ${waited})` : `port ${port} is still in use after ${waited}`);
  return wait.free ? 0 : 1;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
