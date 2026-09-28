import { existsSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { cleanUp, type ReaperState } from './reaper.js';

const POLL_MS = 500;

function say(message: string): void {
  process.stdout.write(`${new Date().toISOString()} reaper: ${message}\n`);
}

/**
 * Entry point of the detached reaper process: `node reaper-main.js <cliPid> <stateFile>`. Every 500 ms it checks its
 * parent PID. When the CLI has died, this process has been re-parented, so its parent PID is no longer the CLI's (unlike
 * `kill(pid, 0)`, this also works while the dead CLI is an unreaped zombie). It then cleans up everything recorded in
 * the state file. When the CLI shuts down normally it deletes the state file, and this process exits on its own.
 */
async function main(cliPid: number, stateFile: string): Promise<void> {
  say(`watching isolate CLI ${cliPid}`);
  while (existsSync(stateFile)) {
    if (process.ppid !== cliPid) {
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as ReaperState;
      say(`CLI ${cliPid} is gone; killing groups [${state.groups.join(', ')}], deleting [${state.dirs.join(', ')}]`);
      const escaped = await cleanUp(state);
      rmSync(stateFile, { force: true });
      say(`cleanup done; processes that had escaped their group: [${escaped.join(', ')}]`);
      return;
    }
    await sleep(POLL_MS);
  }
  say('state file removed by the CLI; exiting');
}

const [cliPid, stateFile] = process.argv.slice(2);
if (cliPid === undefined || stateFile === undefined) throw new Error('usage: reaper-main.js <cliPid> <stateFile>');
await main(Number(cliPid), stateFile);
