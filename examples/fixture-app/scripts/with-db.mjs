// Usage: node scripts/with-db.mjs -- <command...>
// Starts a throwaway Postgres in a fresh temp directory on a free port, creates database `fixture`, migrates and
// seeds it, runs the command with DATABASE_URL set, then stops Postgres, deletes the directory and exits with the
// command's exit code. Its own messages go to stderr only, so the command's stdout (e.g. a JSON report) stays clean.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const appDir = path.join(import.meta.dirname, '..');
const separator = process.argv.indexOf('--');
// `pnpm run test:collide -- --reporter=json` forwards its `--` literally, which would turn the options after it
// into positional arguments of the command, so later `--` separators are dropped.
const command = separator === -1 ? [] : process.argv.slice(separator + 1).filter((arg) => arg !== '--');

function log(message) {
  process.stderr.write(`with-db: ${message}\n`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(argv, env, stdout) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: appDir, env, stdio: ['inherit', stdout, 'inherit'] });
    const forward = (signal) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(code ?? (signal ? 128 + os.constants.signals[signal] : 1));
    });
  });
}

if (command.length === 0) {
  log('usage: node scripts/with-db.mjs -- <command...>');
  process.exit(2);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fixture-pg-'));
const port = await freePort();
const postgresLog = [];
const postgres = new EmbeddedPostgres({
  databaseDir: dataDir,
  port,
  user: 'postgres',
  password: 'postgres',
  persistent: false,
  // Postgres refuses to run as root; as root, the package runs it as the `postgres` system user instead.
  createPostgresUser: process.getuid?.() === 0,
  initdbFlags: ['--no-sync'],
  // TCP only: no Unix socket to collide with another server's or to exceed the socket path length limit.
  postgresFlags: ['-c', 'unix_socket_directories=', '-c', 'fsync=off'],
  onLog: (message) => postgresLog.push(message),
  onError: (error) => postgresLog.push(String(error)),
});

let exitCode = 1;
try {
  const started = performance.now();
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('fixture');
  const env = {
    ...process.env,
    DATABASE_URL: `postgres://postgres:postgres@localhost:${port}/fixture`,
    PATH: `${path.join(appDir, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  for (const script of ['migrate.mjs', 'seed.mjs']) {
    const code = await run(['node', path.join(appDir, 'scripts', script)], env, process.stderr);
    if (code !== 0) throw new Error(`${script} exited with code ${code}`);
  }
  log(`postgres ready on port ${port} in ${Math.round(performance.now() - started)}ms; running: ${command.join(' ')}`);
  exitCode = await run(command, env, 'inherit');
} catch (error) {
  log(error instanceof Error ? error.message : 'postgres failed to start');
  process.stderr.write(postgresLog.join(''));
} finally {
  await postgres.stop();
  await rm(dataDir, { recursive: true, force: true });
}
// Exit explicitly: embedded-postgres installs an exit hook that would otherwise end the process with code 0.
process.exit(exitCode);
