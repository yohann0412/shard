// Scans one cloned repo for Playwright suite size and CI setup. Usage: node scan-suite.mjs <dir> <owner/repo>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';

const [dir, name] = process.argv.slice(2);
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', 'coverage', '.turbo', 'out']);

function walk(root, out = []) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const read = (p) => { try { return statSync(p).size < 2_000_000 ? readFileSync(p, 'utf8') : ''; } catch { return ''; } };
const files = walk(dir);
const code = files.filter((f) => /\.(c|m)?[jt]sx?$/.test(f));
const configs = code.filter((f) => /(^|\/)playwright(\.[\w-]+)?\.config\.(c|m)?[jt]s$/.test(f));

const testFiles = new Set();
function globToRe(g) {
  const base = g.replace(/^\*\*\//, '');
  return new RegExp('(^|/)' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(.*/)?').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
}
const defaultSpec = /\.(spec|test|e2e|e2e-spec)\.(c|m)?[jt]sx?$/;
const pwish = (s) => /@playwright\/test|\bpage\b|from ['"][^'"]*(fixtures?|playwright|test-?utils?)[^'"]*['"]|\brequest\.(get|post|put|delete|patch)\(/.test(s);
const notOtherRunner = (s) => !/from ['"](vitest|@jest\/globals|node:test|bun:test)['"]/.test(s);
const hasTest = (s) => /\btest\s*(\.\w+)?\s*\(/.test(s);
const perConfig = configs.map((cfg) => {
  const src = read(cfg);
  const matchers = [];
  for (const m of src.matchAll(/testMatch:\s*\[?\s*\/((?:[^/\\\n]|\\.)+)\/[a-z]*/g)) { try { matchers.push(new RegExp(m[1])); } catch {} }
  for (const m of src.matchAll(/testMatch:\s*\[?\s*((?:['"`][^'"`]+['"`]\s*,?\s*)+)/g)) for (const g of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) matchers.push(globToRe(g[1]));
  const dirs = [...src.matchAll(/testDir:\s*(?:path\.(?:join|resolve)\(\s*__dirname\s*,\s*)?['"`]([^'"`$]+)['"`]/g)].map((m) => resolve(dirname(cfg), m[1]));
  return { dirs: dirs.length ? dirs : [dirname(cfg)], matchers, loose: dirs.length === 0 && matchers.length === 0 };
});
for (const f of code) {
  const owner = perConfig.find((c) => c.dirs.some((d) => f.startsWith(d + '/')) && (c.matchers.length ? c.matchers.some((re) => re.test(f)) : defaultSpec.test(f)));
  if (owner) {
    const src = read(f);
    if ((!owner.loose || pwish(src)) && hasTest(src) && notOtherRunner(src)) { testFiles.add(f); continue; }
  }
  if (defaultSpec.test(f)) {
    const src = read(f);
    if (/from ['"]@playwright\/test['"]/.test(src) && hasTest(src)) testFiles.add(f);
  }
}
let tests = 0;
for (const f of testFiles) tests += (read(f).match(/\b(test|it)(\.(only|fixme|fail|slow|skip))?\s*\(\s*[`'"]/g) ?? []).length;

const workflows = files.filter((f) => /\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
const ci = [];
for (const wf of workflows) {
  const src = read(wf);
  if (!/playwright/i.test(src)) continue;
  const shardTotals = [
    ...[...src.matchAll(/--shard[= ][^\n/]*\/\s*(\d+)/g)].map((m) => +m[1]),
    ...[...src.matchAll(/shard(?:Total|_total|s)?:\s*\[([\d,\s]+)\]/gi)].map((m) => m[1].split(',').filter((x) => x.trim()).length),
    ...[...src.matchAll(/(?:total|shard)[-_]?(?:shards|total|count)?:\s*(\d+)\s*$/gim)].map((m) => +m[1]),
  ].filter((n) => n > 1 && n < 200);
  const timeouts = [...src.matchAll(/timeout-minutes:\s*(\d+)/g)].map((m) => +m[1]);
  const workers = [...src.matchAll(/--workers[= ](\S+)/g)].map((m) => m[1]);
  ci.push({ file: relative(dir, wf), maxShards: shardTotals.length ? Math.max(...shardTotals) : 1, maxTimeout: timeouts.length ? Math.max(...timeouts) : null, workers });
}

const workerSettings = configs.map((c) => (read(c).match(/workers:\s*([^,\n]+)/) ?? [])[1]?.trim()).filter(Boolean);
console.log(JSON.stringify({
  name,
  configs: configs.length,
  specFiles: testFiles.size,
  tests,
  workerSettings: [...new Set(workerSettings)].slice(0, 4),
  ciWorkflows: ci.length,
  ciMaxShards: ci.length ? Math.max(...ci.map((c) => c.maxShards)) : 0,
  ciMaxTimeoutMin: ci.length ? Math.max(0, ...ci.map((c) => c.maxTimeout ?? 0)) : null,
  ciWorkers: [...new Set(ci.flatMap((c) => c.workers))].slice(0, 4),
  ciFiles: ci.map((c) => c.file).slice(0, 5),
}));
