import path from 'node:path';

/** Every path isolate writes inside a repository's `.isolate/` directory. */
export function isolatePaths(repoDir: string) {
  const root = path.join(repoDir, '.isolate');
  return {
    root,
    logs: path.join(root, 'logs'),
    appLog: (index: number) => path.join(root, 'logs', `w${index}.log`),
    postgresLog: path.join(root, 'logs', 'postgres.log'),
    buildLog: path.join(root, 'logs', 'build.log'),
    migrateSeedLog: path.join(root, 'logs', 'migrate-seed.log'),
    reaperLog: path.join(root, 'logs', 'reaper.log'),
    proxyLog: path.join(root, 'logs', 'proxy.log'),
    reaperState: (pid: number) => path.join(root, `reaper-${pid}.json`),
    cache: path.join(root, 'cache'),
    report: path.join(root, 'report.json'),
    pwResults: path.join(root, 'pw-results.json'),
    rerunResults: path.join(root, 'rerun-results.json'),
    rerunsLog: path.join(root, 'logs', 'reruns.log'),
    rerunAppLog: (run: number) => path.join(root, 'logs', `rerun-${run}.log`),
    /** Playwright's output directory (traces, screenshots) of each rerun, so reruns do not empty the main run's. */
    rerunOutputs: path.join(root, 'rerun-output'),
    rerunOutput: (run: number) => path.join(root, 'rerun-output', String(run)),
    map: path.join(root, 'map.json'),
  };
}
