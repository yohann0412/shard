import path from 'node:path';

/** Every path isolate writes inside a repository's `.isolate/` directory. */
export function isolatePaths(repoDir: string) {
  const root = path.join(repoDir, '.isolate');
  return {
    root,
    logs: path.join(root, 'logs'),
    appLog: (index: number) => path.join(root, 'logs', `w${index}.log`),
    postgresLog: path.join(root, 'logs', 'postgres.log'),
    cache: path.join(root, 'cache'),
    report: path.join(root, 'report.json'),
    pwResults: path.join(root, 'pw-results.json'),
    map: path.join(root, 'map.json'),
    trace: path.join(root, 'trace'),
  };
}
