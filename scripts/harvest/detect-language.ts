import path from 'node:path';
import { appPackages, capped, dependencies, isAppPath } from './patterns.js';
import { depth, dirOf, join, type RepoSnapshot } from './repo.js';
import type { Candidate } from './schema.js';

type Language = Candidate['backendLanguage']['kind'];

/** A file that points at a backend language. */
interface Hit {
  path: string;
  language: Language;
}

const MANIFESTS: Array<[RegExp, Language]> = [
  [/(^|\/)go\.mod$/, 'go'],
  [/(^|\/)(pyproject\.toml|setup\.py|manage\.py)$/, 'python'],
  [/(^|\/)composer\.json$/, 'php'],
  [/(^|\/)(pom\.xml|build\.gradle(\.kts)?|build\.sbt|deps\.edn|project\.clj)$/, 'java'],
  [/(^|\/)Cargo\.toml$/, 'rust'],
  [/(^|\/)mix\.exs$/, 'elixir'],
];
const DOTNET = /\.(csproj|fsproj|sln)$/;
const PYTHON_REQUIREMENTS = /(^|\/)(requirements[\w-]*\.txt|Pipfile)$/;
const NOT_BACKEND_DIR = /(^|\/)(scripts?|tools?|e2e|tests?|bdd|\.github|\.devcontainer|benchmarks?|website|playwright|infra|deploy|packaging|ci|hack|bin|sdks?|clients?|android|ios|mobile|desktop|electron|src-tauri)\//i;
const SERVER_DIR = /^[\w.-]*(server|backend|back-end|api)$/i;
const NODE_SERVER_DEPENDENCIES = /^(express|fastify|koa|@hapi\/hapi|@nestjs\/core|hono|h3|elysia|@adonisjs\/core|@feathersjs\/feathers|@strapi\/strapi|@strapi\/core|payload|@medusajs\/medusa|@trpc\/server|restify|polka|@apollo\/server|apollo-server(-express)?|graphql-yoga|@keystone-6\/core|@redwoodjs\/api|nitropack|sails)$/;
const NODE_FRAMEWORKS = /^(next|nuxt|@sveltejs\/kit|@remix-run\/(node|server-runtime|serve)|@react-router\/(node|serve)|@solidjs\/start|@tanstack\/(react-|solid-)?start|@astrojs\/node|blitz|@builder\.io\/qwik-city|@analogjs\/platform|vinxi)$/;
const NODE_START = /\b(node|ts-node|tsx|nodemon|pm2|bun)\s/;

/** Non-Node manifests; a Gemfile only counts next to a config.ru (a Rack app, not a Fastlane toolchain). */
function otherLanguages(repo: RepoSnapshot): Hit[] {
  const candidates = repo.paths.filter((p) => isAppPath(p) && !NOT_BACKEND_DIR.test(p));
  const hits: Hit[] = [];
  for (const p of candidates) {
    const language = MANIFESTS.find(([pattern]) => pattern.test(p))?.[1];
    if (language && depth(p) <= 3) hits.push({ path: p, language });
    else if (DOTNET.test(p)) hits.push({ path: p, language: 'dotnet' });
    else if (/(^|\/)Gemfile$/.test(p) && depth(p) <= 3 && repo.has(join(dirOf(p), 'config.ru'))) hits.push({ path: p, language: 'ruby' });
    else if (PYTHON_REQUIREMENTS.test(p) && depth(p) <= 3 && SERVER_DIR.test(path.posix.basename(dirOf(p)))) hits.push({ path: p, language: 'python' });
  }
  return hits;
}

/** Node server evidence: server-framework dependencies, a Meteor app, or (failing those) a `start` script that runs node. */
function nodeServers(repo: RepoSnapshot): Array<{ path: string; text: string }> {
  const hits: Array<{ path: string; text: string }> = [];
  if (repo.has('.meteor/release')) hits.push({ path: 'package.json', text: '.meteor/release: Meteor app' });
  for (const [p, manifest] of appPackages(repo)) {
    const servers = dependencies(manifest, false).filter((d) => NODE_SERVER_DEPENDENCIES.test(d));
    const frameworks = dependencies(manifest).filter((d) => NODE_FRAMEWORKS.test(d));
    hits.push(...[...servers, ...frameworks].map((d) => ({ path: p, text: `${p}: dependency ${d}` })));
  }
  if (hits.length > 0) return hits;
  for (const [p, manifest] of appPackages(repo)) {
    const start = manifest.scripts?.start;
    if (start !== undefined && NODE_START.test(`${start} `)) hits.push({ path: p, text: `${p}: start script "${start.slice(0, 60)}"` });
  }
  return hits;
}

/**
 * The backend language, in this order: a non-Node manifest at the root (unless the root package.json is a Node server);
 * a non-Node manifest in a server/backend/api directory (depth <= 3); Node server evidence; any other manifest.
 */
export function detectLanguage(repo: RepoSnapshot): Candidate['backendLanguage'] {
  const others = otherLanguages(repo);
  const node = nodeServers(repo);
  const evidence = [...node.map((hit) => `node: ${hit.text}`), ...others.map((hit) => `${hit.language}: ${hit.path}`)];
  const pick = (kind: Language) => ({
    kind,
    evidence: capped([...evidence.filter((e) => e.startsWith(`${kind}:`)), ...evidence.filter((e) => !e.startsWith(`${kind}:`))]),
  });
  const rootOther = others.find((hit) => depth(hit.path) === 1);
  if (rootOther && !node.some((hit) => hit.path === 'package.json')) return pick(rootOther.language);
  const serverOther = others.find((hit) => depth(hit.path) <= 3 && SERVER_DIR.test(path.posix.basename(dirOf(hit.path))));
  if (serverOther) return pick(serverOther.language);
  if (node.length > 0) return pick('node');
  const other = others[0];
  if (other) return pick(other.language);
  return { kind: 'unknown', evidence: ['no Node server dependency and no other backend manifest found'] };
}
