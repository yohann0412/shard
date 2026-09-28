import { execa } from 'execa';
import { log } from '../log.js';

/** An unprivileged account to run Postgres as. */
export interface PostgresUser {
  name: string;
  uid: number;
  gid: number;
}

const CREATED_USER = 'isolate-pg';

async function lookUpUser(name: string): Promise<PostgresUser | undefined> {
  const result = await execa('getent', ['passwd', name], { reject: false });
  if (result.exitCode !== 0) return undefined;
  const [, , uid, gid] = result.stdout.trim().split(':');
  return { name, uid: Number(uid), gid: Number(gid) };
}

/**
 * Returns the account Postgres must run as, or undefined when isolate is not root. `initdb` and `postgres` refuse to
 * run as root, so as root we use the `postgres` system user if it exists and otherwise create `isolate-pg`.
 */
export async function postgresUser(): Promise<PostgresUser | undefined> {
  if (process.getuid?.() !== 0) return undefined;
  let user = (await lookUpUser('postgres')) ?? (await lookUpUser(CREATED_USER));
  if (user === undefined) {
    log.info(`running as root and there is no postgres user; creating system user ${CREATED_USER}`);
    await execa('useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', CREATED_USER]);
    user = await lookUpUser(CREATED_USER);
  }
  if (user === undefined) throw new Error(`could not find or create a user to run Postgres as (tried postgres and ${CREATED_USER})`);
  log.info(`running as root, so Postgres runs as user ${user.name} (uid ${user.uid})`);
  return user;
}

/**
 * The command line that runs `file args` as `user`: through `setpriv`, which switches user and then execs in place, so
 * the spawned PID is the program itself (su and runuser fork and would leave a parent in between). Unchanged without a user.
 */
export function asUser(user: PostgresUser | undefined, file: string, args: string[]): { file: string; args: string[] } {
  if (user === undefined) return { file, args };
  return { file: 'setpriv', args: [`--reuid=${user.uid}`, `--regid=${user.gid}`, '--clear-groups', '--', file, ...args] };
}
