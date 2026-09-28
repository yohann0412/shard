import path from 'node:path';

/** Path of `file` relative to `rootDir`, with forward slashes on every platform. */
export function relativeFile(rootDir: string, file: string): string {
  return path.relative(rootDir, file).split(path.sep).join('/');
}

/** Stable id of one test: project name, file relative to `rootDir`, then the describe and test titles below the file. */
export function testId(projectName: string, rootDir: string, file: string, titlesBelowFile: readonly string[]): string {
  return [projectName, relativeFile(rootDir, file), ...titlesBelowFile].join(' › ');
}
