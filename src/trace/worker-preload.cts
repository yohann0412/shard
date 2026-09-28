/**
 * Loaded with `NODE_OPTIONS=--require` into the Playwright command by `isolate trace`. In Playwright worker processes
 * only, it wraps every test in POST /begin and POST /end to the isolate controller (which takes the app's server
 * coverage at those points), and collects Chromium's JS coverage of every page opened during the test.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import type { BeginRequest, ClientScript, EndRequest } from './protocol.js';

/** The reporter's test id module; required lazily, since a module hooks thread cannot require ES modules. */
type TestIds = typeof import('../playwright/test-id.js');

/** Playwright forks its workers from this file, relative to the playwright package. */
const WORKER_ENTRY = path.join('lib', 'common', 'process.js');
/** Worker entry of later Playwright versions (1.63 has it), which bundle WorkerMain where it cannot be patched. */
const BUNDLED_WORKER_ENTRY = path.join('lib', 'worker', 'workerProcessEntry.js');

const SOURCE_MAP_COMMENT = /\/\/[#@]\s*sourceMappingURL=/;

/** The parts of Playwright's internal TestCase that the test id needs. */
interface TestCase {
  title: string;
  location: { file: string };
  titlePath(): string[];
}

/** The parts of Playwright's internal WorkerMain that the patch uses. */
interface WorkerMain {
  _project?: { project: { name: string } };
}

type RunTest = (this: WorkerMain, test: TestCase, ...rest: unknown[]) => Promise<unknown>;

/** One entry of Page.coverage.stopJSCoverage(). */
interface CoverageEntry {
  url: string;
  source?: string;
  functions: { functionName: string; ranges: { startOffset: number; endOffset: number; count: number }[] }[];
}

/** The parts of playwright-core's client Page that the patch uses. */
interface Page {
  coverage: {
    startJSCoverage(options: { resetOnNavigation: boolean; reportAnonymousScripts: boolean }): Promise<void>;
    stopJSCoverage(): Promise<CoverageEntry[]>;
  };
  isClosed(): boolean;
  close(...args: unknown[]): Promise<void>;
}

/** The parts of playwright-core's client BrowserContext that the patch uses. */
interface BrowserContext {
  browser(): { browserType(): { name(): string } } | null;
  pages(): Page[];
  newPage(...args: unknown[]): Promise<Page>;
  close(...args: unknown[]): Promise<void>;
}

/** Pages whose JS coverage is running. */
const covered = new Set<Page>();
/** Client coverage collected since the last POST /end. */
let collected: ClientScript[] = [];
/** Scripts whose source this worker already sent; the controller keeps sources by URL. */
const sentSources = new Set<string>();

function warn(message: string): void {
  process.stderr.write(`[isolate trace] worker ${process.env.TEST_PARALLEL_INDEX ?? '?'}: ${message}\n`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Loads a module of a Playwright package by absolute path (which bypasses the package's `exports`). */
function load<T>(file: string): T {
  return require(file) as T;
}

/** Keeps only http(s) scripts and their executed functions; attaches a source map-bearing source once per URL. */
function compact(entries: CoverageEntry[]): ClientScript[] {
  const scripts: ClientScript[] = [];
  for (const entry of entries) {
    if (!/^https?:/.test(entry.url)) continue;
    const functions = entry.functions.flatMap((fn) => {
      const range = fn.ranges[0];
      if (range === undefined || range.count === 0) return [];
      return [{ name: fn.functionName, startOffset: range.startOffset, endOffset: range.endOffset, count: range.count }];
    });
    if (functions.length === 0) continue;
    const script: ClientScript = { url: entry.url, functions };
    if (entry.source !== undefined && SOURCE_MAP_COMMENT.test(entry.source) && !sentSources.has(entry.url)) {
      sentSources.add(entry.url);
      script.source = entry.source;
    }
    scripts.push(script);
  }
  return scripts;
}

async function startCoverage(page: Page): Promise<void> {
  await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
  covered.add(page);
}

/** Stops a covered page's coverage and keeps what it recorded. */
async function collect(page: Page): Promise<void> {
  if (!covered.delete(page)) return;
  try {
    collected.push(...compact(await page.coverage.stopJSCoverage()));
  } catch (error) {
    warn(`lost the client coverage of one page: ${describe(error)}`);
  }
}

/** Collects pages that outlive the test (for example opened in beforeAll) and restarts their coverage for the next test. */
async function collectOpenPages(): Promise<void> {
  await Promise.all(
    [...covered].map(async (page) => {
      if (page.isClosed()) {
        covered.delete(page);
        return;
      }
      await collect(page);
      await startCoverage(page).catch((error: unknown) => warn(`could not restart client coverage: ${describe(error)}`));
    }),
  );
}

/** Makes every new Chromium page start JS coverage before it is returned, and collects it before a page or context closes. */
function patchClient(coreDir: string): void {
  const { BrowserContext } = load<{ BrowserContext?: { prototype: BrowserContext } }>(path.join(coreDir, 'lib', 'client', 'browserContext.js'));
  const { Page } = load<{ Page?: { prototype: Page } }>(path.join(coreDir, 'lib', 'client', 'page.js'));
  const contextProto = BrowserContext?.prototype;
  const pageProto = Page?.prototype;
  if (typeof contextProto?.newPage !== 'function' || typeof contextProto.close !== 'function' || typeof pageProto?.close !== 'function') {
    throw new Error(`isolate trace: ${coreDir} has no client BrowserContext.newPage/close or Page.close to patch (RISKS R15)`);
  }

  const newPage = contextProto.newPage;
  contextProto.newPage = async function (this: BrowserContext, ...args: unknown[]): Promise<Page> {
    const page = await newPage.apply(this, args);
    if (this.browser()?.browserType().name() === 'chromium') await startCoverage(page);
    return page;
  };
  const closeContext = contextProto.close;
  contextProto.close = async function (this: BrowserContext, ...args: unknown[]): Promise<void> {
    await Promise.all(this.pages().map(collect));
    return closeContext.apply(this, args);
  };
  const closePage = pageProto.close;
  pageProto.close = async function (this: Page, ...args: unknown[]): Promise<void> {
    await collect(this);
    return closePage.apply(this, args);
  };
}

/** POSTs one hook call to the controller; a failure is reported and does not fail the test. */
async function notify(controlUrl: string, route: '/begin' | '/end', body: BeginRequest | EndRequest): Promise<void> {
  try {
    const response = await fetch(new URL(route, controlUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) warn(`${route} for ${body.testId}: HTTP ${response.status} ${await response.text()}`);
  } catch (error) {
    warn(`${route} for ${body.testId} failed: ${describe(error)}`);
  }
}

/**
 * Wraps WorkerMain.prototype._runTest in /begin and /end calls; throws if Playwright no longer has it. Test ids come
 * from the reporter's own function, so both sides name every test the same way.
 */
function patchRunTest(playwrightDir: string, controlUrl: string, root: string): void {
  const { relativeFile, testId } = require('../playwright/test-id.js') as TestIds;
  const { WorkerMain } = load<{ WorkerMain?: { prototype: { _runTest?: RunTest } } }>(path.join(playwrightDir, 'lib', 'worker', 'workerMain.js'));
  const runTest = WorkerMain?.prototype._runTest;
  if (WorkerMain === undefined || typeof runTest !== 'function') {
    throw new Error(`isolate trace: ${playwrightDir} has no WorkerMain.prototype._runTest; this Playwright version cannot be traced (RISKS R15)`);
  }
  WorkerMain.prototype._runTest = async function (this: WorkerMain, test: TestCase, ...rest: unknown[]): Promise<unknown> {
    const project = this._project?.project.name;
    if (project === undefined) throw new Error('isolate trace: WorkerMain has no _project when a test starts (RISKS R15)');
    const worker = Number(process.env.TEST_PARALLEL_INDEX);
    const id = testId(project, root, test.location.file, test.titlePath().slice(1));
    await notify(controlUrl, '/begin', { worker, testId: id, title: test.title, file: relativeFile(root, test.location.file) });
    try {
      return await runTest.call(this, test, ...rest);
    } finally {
      await collectOpenPages();
      const client = collected;
      collected = [];
      await notify(controlUrl, '/end', { worker, testId: id, client });
    }
  };
}

// Node also runs --require preloads in the thread of any registered module hooks (Playwright registers some); only the
// main thread of a Playwright worker process runs tests.
const entry = process.argv[1] ?? '';
if (isMainThread && entry.endsWith(BUNDLED_WORKER_ENTRY)) {
  throw new Error(`isolate trace: ${entry} bundles WorkerMain, so this Playwright version cannot be traced (RISKS R15)`);
}
if (isMainThread && entry.endsWith(WORKER_ENTRY)) {
  const controlUrl = process.env.ISOLATE_CONTROL_URL;
  const root = process.env.ISOLATE_TRACE_ROOT;
  if (!controlUrl || !root) throw new Error('isolate trace: ISOLATE_CONTROL_URL and ISOLATE_TRACE_ROOT must be set');
  const playwrightDir = path.resolve(path.dirname(entry), '..', '..');
  const coreDir = path.dirname(createRequire(path.join(playwrightDir, 'package.json')).resolve('playwright-core/package.json'));
  patchRunTest(playwrightDir, controlUrl, root);
  patchClient(coreDir);
}
