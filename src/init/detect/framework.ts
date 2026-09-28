import { dependencyNames, readPackageJson } from '../files.js';

/** True if the package in `appDir` is a Next.js app. */
export function isNextApp(appDir: string): boolean {
  return dependencyNames(readPackageJson(appDir)).includes('next');
}
