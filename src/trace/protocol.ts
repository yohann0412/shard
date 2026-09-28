/** A function that ran at least once since the previous take, with its offsets in the script's source. */
export interface ExecutedFunction {
  name: string;
  startOffset: number;
  endOffset: number;
  count: number;
}

/** A server function; `isTopLevel` marks the module-level function (offset 0, empty name). */
export interface ServerFunction extends ExecutedFunction {
  isTopLevel: boolean;
}

/** Executed functions of one server script, identified by its URL (file:// or a bundler URL). */
export interface ServerScript {
  url: string;
  functions: ServerFunction[];
}

/** What one app process answers to a take: everything it executed in repo files since its previous take. */
export interface TakeReply {
  pid: number;
  /** True if in-flight HTTP requests had not finished within the wait limit when coverage was taken. */
  timedOut: boolean;
  scripts: ServerScript[];
}

/** Executed functions of one browser script; `source` is sent once per worker, only for scripts with a source map. */
export interface ClientScript {
  url: string;
  functions: ExecutedFunction[];
  source?: string;
}

/** Body of POST /begin, sent by a Playwright worker before each test. */
export interface BeginRequest {
  worker: number;
  testId: string;
  title: string;
  /** Test file relative to the repository root, with forward slashes. */
  file: string;
}

/** Body of POST /end, sent by a Playwright worker after each test. */
export interface EndRequest {
  worker: number;
  testId: string;
  client: ClientScript[];
}
