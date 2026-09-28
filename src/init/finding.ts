/** A config value and where it came from. */
export interface Finding<T> {
  value: T;
  /** The evidence (e.g. `webServer.url in playwright.config.ts`), or for a guess, what was looked for and not found. */
  source: string;
  guessed: boolean;
}

/** A value found in the repo. */
export function found<T>(value: T, source: string): Finding<T> {
  return { value, source, guessed: false };
}

/** A fallback value used because nothing in the repo said otherwise. */
export function guess<T>(value: T, source: string): Finding<T> {
  return { value, source, guessed: true };
}
