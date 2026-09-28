/**
 * Loaded with `NODE_OPTIONS=--require` into the Playwright command by `isolate trace`. In Playwright worker processes
 * only, it wraps every test in POST /begin and POST /end to the isolate controller (which takes the app's server
 * coverage at those points), and collects Chromium's JS coverage of the pages opened during the test. It patches
 * Playwright internals where they can be reached (1.56), and otherwise extends the public `test` (1.63).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import type { BeginRequest, ClientScript, EndRequest } from './protocol.js';

/** The reporter's test id module; required lazily, since a module hooks thread cannot require ES modules. */
type TestIds = typeof import('../playwright/test-id.js');

/** Playwright forks its workers from one of these files, relative to the playwright package (1.63 uses the second). */
const WORKER_ENTRIES = [path.join('lib', 'common', 'process.js'), path.join('lib', 'worker', 'workerProcessEntry.js')];

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

/** The parts of Playwright's public TestInfo that the fixture hook uses; `titlePath` is the test's `titlePath()`. */
interface TestInfo {
  title: string;
  file: string;
  titlePath: string[];
  project: { name: string };
}

/** The parts of Playwright's public `test` function that the fixture hook uses. */
interface TestType {
  extend(fixtures: Record<string, unknown>): TestType;
}

/** A fixture's `use` callback. */
type Use<T> = (value: T) => Promise<void>;

/** One entry of Page.coverage.stopJSCoverage(). */
interface CoverageEntry {
  url: string;
  source?: string;
  functions: { functionName: string; ranges: { startOffset: number; endOffset: number; count: number }[] }[];
}

/** The parts of playwright-core's client Page that the hooks use. */
interface Page {
  coverage: {
    startJSCoverage(options: { resetOnNavigation: boolean; reportAnonymousScripts: boolean }): Promise<void>;
    stopJSCoverage(): Promise<CoverageEntry[]>;
  };
  isClosed(): boolean;
  close(...args: unknown[]): Promise<void>;
}

/** The parts of playwright-core's client BrowserContext that the hooks use. */
interface BrowserContext {
  browser(): { browserType(): { name(): string } } | null;
  pages(): Page[];
  newPage(...args: unknown[]): Promise<Page>;
  close(...args: unknown[]): Promise<void>;
}

/** Playwright internals that the `_runTest` hook patches; Playwright 1.63 bundles them where they cannot be reached. */
interface Internals {
  workerMain: { prototype: { _runTest: RunTest } };
  contextProto: BrowserContext;
  pageProto: Page;
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

/** Hands out the client coverage collected so far, for one POST /end. */
function takeCollected(): ClientScript[] {
  const client = collected;
  collected = [];
  return client;
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
 * WorkerMain and the client BrowserContext and Page classes, if this Playwright version ships them as separate modules
 * with the methods the `_runTest` hook patches (1.56 does), else null.
 */
function findInternals(playwrightDir: string): Internals | null {
  const coreDir = path.dirname(createRequire(path.join(playwrightDir, 'package.json')).resolve('playwright-core/package.json'));
  const workerMainFile = path.join(playwrightDir, 'lib', 'worker', 'workerMain.js');
  const contextFile = path.join(coreDir, 'lib', 'client', 'browserContext.js');
  const pageFile = path.join(coreDir, 'lib', 'client', 'page.js');
  if (![workerMainFile, contextFile, pageFile].every((file) => existsSync(file))) return null;
  const { WorkerMain } = load<{ WorkerMain?: { prototype: { _runTest?: RunTest } } }>(workerMainFile);
  const contextProto = load<{ BrowserContext?: { prototype: BrowserContext } }>(contextFile).BrowserContext?.prototype;
  const pageProto = load<{ Page?: { prototype: Page } }>(pageFile).Page?.prototype;
  if (typeof WorkerMain?.prototype._runTest !== 'function') return null;
  if (typeof contextProto?.newPage !== 'function' || typeof contextProto.close !== 'function' || typeof pageProto?.close !== 'function') return null;
  return { workerMain: WorkerMain as Internals['workerMain'], contextProto, pageProto };
}

/** Makes every new Chromium page start JS coverage before it is returned, and collects it before a page or context closes. */
function patchClient({ contextProto, pageProto }: Internals): void {
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

/**
 * Wraps WorkerMain.prototype._runTest in /begin and /end calls, so beforeAll and afterAll hooks count toward the test
 * they run with. Test ids come from the reporter's own function, so both sides name every test the same way.
 */
function patchRunTest({ workerMain }: Internals, controlUrl: string, root: string): void {
  const { relativeFile, testId } = require('../playwright/test-id.js') as TestIds;
  const runTest = workerMain.prototype._runTest;
  workerMain.prototype._runTest = async function (this: WorkerMain, test: TestCase, ...rest: unknown[]): Promise<unknown> {
    const project = this._project?.project.name;
    if (project === undefined) throw new Error('isolate trace: WorkerMain has no _project when a test starts (RISKS R15)');
    const worker = Number(process.env.TEST_PARALLEL_INDEX);
    const id = testId(project, root, test.location.file, test.titlePath().slice(1));
    await notify(controlUrl, '/begin', { worker, testId: id, title: test.title, file: relativeFile(root, test.location.file) });
    try {
      return await runTest.call(this, test, ...rest);
    } finally {
      await collectOpenPages();
      await notify(controlUrl, '/end', { worker, testId: id, client: takeCollected() });
    }
  };
}

/**
 * The hook for Playwright versions without reachable internals (1.63), through public API only: the `test` that
 * `playwright/test` exports (and `@playwright/test` re-exports) becomes an extension of itself with an automatic
 * test-scoped fixture that calls /begin before the test's fixtures and beforeEach hooks and /end after its afterEach
 * hooks, and a `context` override that covers the Chromium pages the test opens with `context.newPage()` (which is how
 * the `page` fixture gets its page). Throws if this Playwright version has no `test.extend` to use.
 */
function extendTest(playwrightDir: string, controlUrl: string, root: string): void {
  const { relativeFile, testId } = require('../playwright/test-id.js') as TestIds;
  const exports = createRequire(path.join(playwrightDir, 'package.json'))('playwright/test') as { test?: TestType };
  const base = exports.test;
  if (typeof base?.extend !== 'function') throw new Error(`isolate trace: ${playwrightDir} exports no test.extend from playwright/test (RISKS R15)`);

  const traceTest = async ({}: object, use: Use<void>, testInfo: TestInfo): Promise<void> => {
    const worker = Number(process.env.TEST_PARALLEL_INDEX);
    const id = testId(testInfo.project.name, root, testInfo.file, testInfo.titlePath.slice(1));
    await notify(controlUrl, '/begin', { worker, testId: id, title: testInfo.title, file: relativeFile(root, testInfo.file) });
    await use();
    await notify(controlUrl, '/end', { worker, testId: id, client: takeCollected() });
  };
  const coverContext = async ({ context }: { context: BrowserContext }, use: Use<BrowserContext>): Promise<void> => {
    if (context.browser()?.browserType().name() === 'chromium') {
      const newPage = context.newPage.bind(context);
      context.newPage = async (...args: unknown[]): Promise<Page> => {
        const page = await newPage(...args);
        await startCoverage(page);
        const closePage = page.close.bind(page);
        page.close = async (...closeArgs: unknown[]): Promise<void> => {
          await collect(page);
          return closePage(...closeArgs);
        };
        return page;
      };
    }
    await use(context);
    await Promise.all(context.pages().map(collect));
  };
  const traced = base.extend({ _isolateTrace: [traceTest, { auto: true, timeout: 0, box: 'self' }], context: coverContext });
  // ES module test files (through test.mjs) see the exports object that test.js created, not a replacement put into
  // require.cache, so `test` becomes an accessor on that object.
  Object.defineProperty(exports, 'test', { get: () => traced, enumerable: true, configurable: true });
}

// Node also runs --require preloads in the thread of any registered module hooks (Playwright registers some); only the
// main thread of a Playwright worker process runs tests.
const entry = process.argv[1] ?? '';
if (isMainThread && WORKER_ENTRIES.some((file) => entry.endsWith(file))) {
  const controlUrl = process.env.ISOLATE_CONTROL_URL;
  const root = process.env.ISOLATE_TRACE_ROOT;
  if (!controlUrl || !root) throw new Error('isolate trace: ISOLATE_CONTROL_URL and ISOLATE_TRACE_ROOT must be set');
  const playwrightDir = path.resolve(path.dirname(entry), '..', '..');
  const internals = findInternals(playwrightDir);
  if (internals === null) {
    extendTest(playwrightDir, controlUrl, root);
  } else {
    patchRunTest(internals, controlUrl, root);
    patchClient(internals);
  }
}
