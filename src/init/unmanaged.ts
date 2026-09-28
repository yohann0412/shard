import { readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BUILD_TIME_PREFIX } from './detect/self-urls.js';
import { envExampleEntries } from './env-files.js';
import { dependencyNames, isDir, readPackageJson, readText, relPath, searchableSubdirs } from './files.js';
import { findWorkspace } from './workspace.js';

/** A service the app uses that V1 neither starts nor copies per worker (D-012), with what showed it. */
export const unmanagedServiceSchema = z.object({
  service: z.string(),
  kind: z.enum(['stateful', 'third-party']),
  evidence: z.array(z.string()),
});

/** One unmanaged service found in the repo. */
export type UnmanagedService = z.infer<typeof unmanagedServiceSchema>;

type Kind = UnmanagedService['kind'];

const PACKAGES: Record<string, [string, Kind]> = {
  ioredis: ['redis', 'stateful'],
  redis: ['redis', 'stateful'],
  '@redis/client': ['redis', 'stateful'],
  '@upstash/redis': ['redis', 'stateful'],
  '@vercel/kv': ['redis', 'stateful'],
  iovalkey: ['redis', 'stateful'],
  bullmq: ['redis', 'stateful'],
  bull: ['redis', 'stateful'],
  'bee-queue': ['redis', 'stateful'],
  'connect-redis': ['redis', 'stateful'],
  memcached: ['memcached', 'stateful'],
  memjs: ['memcached', 'stateful'],
  '@aws-sdk/client-s3': ['s3', 'stateful'],
  minio: ['s3', 'stateful'],
  '@google-cloud/storage': ['gcs', 'stateful'],
  '@azure/storage-blob': ['azure-blob', 'stateful'],
  '@vercel/blob': ['vercel-blob', 'stateful'],
  'aws-sdk': ['aws', 'third-party'],
  amqplib: ['rabbitmq', 'stateful'],
  'amqp-connection-manager': ['rabbitmq', 'stateful'],
  kafkajs: ['kafka', 'stateful'],
  '@confluentinc/kafka-javascript': ['kafka', 'stateful'],
  nats: ['nats', 'stateful'],
  '@aws-sdk/client-sqs': ['sqs', 'stateful'],
  'sqs-consumer': ['sqs', 'stateful'],
  '@elastic/elasticsearch': ['elasticsearch', 'stateful'],
  '@opensearch-project/opensearch': ['elasticsearch', 'stateful'],
  meilisearch: ['meilisearch', 'stateful'],
  typesense: ['typesense', 'stateful'],
  mongodb: ['mongodb', 'stateful'],
  mongoose: ['mongodb', 'stateful'],
  '@clickhouse/client': ['clickhouse', 'stateful'],
  nodemailer: ['smtp', 'stateful'],
  stripe: ['stripe', 'third-party'],
  openai: ['openai', 'third-party'],
  '@anthropic-ai/sdk': ['anthropic', 'third-party'],
  '@sendgrid/mail': ['sendgrid', 'third-party'],
  resend: ['resend', 'third-party'],
  twilio: ['twilio', 'third-party'],
  postmark: ['postmark', 'third-party'],
  'mailgun.js': ['mailgun', 'third-party'],
  '@aws-sdk/client-ses': ['ses', 'third-party'],
  '@slack/web-api': ['slack', 'third-party'],
  algoliasearch: ['algolia', 'third-party'],
  pusher: ['pusher', 'third-party'],
  'firebase-admin': ['firebase', 'third-party'],
};

const ENV_KEYS: Array<[RegExp, string, Kind]> = [
  [/^(REDIS|VALKEY|KV|UPSTASH_REDIS)(_|$)|_REDIS_/, 'redis', 'stateful'],
  [/(^|_)(S3|MINIO)(_|$)/, 's3', 'stateful'],
  [/^(SMTP|EMAIL_SERVER)(_|$)|^(MAIL|MAILER)_(HOST|PORT|SERVER|DSN|URL)$/, 'smtp', 'stateful'],
  [/^(RABBITMQ|AMQP)_/, 'rabbitmq', 'stateful'],
  [/^KAFKA_/, 'kafka', 'stateful'],
  [/^NATS_/, 'nats', 'stateful'],
  [/(^|_)SQS(_|$)/, 'sqs', 'stateful'],
  [/^(ELASTIC(SEARCH)?|OPENSEARCH)_/, 'elasticsearch', 'stateful'],
  [/^MEILI(SEARCH)?_/, 'meilisearch', 'stateful'],
  [/^TYPESENSE_/, 'typesense', 'stateful'],
  [/^MONGO(DB)?_/, 'mongodb', 'stateful'],
  [/^CLICKHOUSE_/, 'clickhouse', 'stateful'],
  [/^MEMCACHED?_/, 'memcached', 'stateful'],
  [/^AWS_/, 'aws', 'third-party'],
];

const URL_SCHEMES: Array<[RegExp, string]> = [
  [/^rediss?:\/\//, 'redis'],
  [/^amqps?:\/\//, 'rabbitmq'],
  [/^mongodb(\+srv)?:\/\//, 'mongodb'],
  [/^nats:\/\//, 'nats'],
  [/^smtps?:\/\//, 'smtp'],
  [/^clickhouse:\/\//, 'clickhouse'],
];

/** Services whose credentials mark a third-party API (`STRIPE_SECRET_KEY`, `GITHUB_TOKEN`, ...). */
const THIRD_PARTIES = new Set([
  'STRIPE', 'OPENAI', 'ANTHROPIC', 'SENDGRID', 'RESEND', 'TWILIO', 'POSTMARK', 'MAILGUN', 'MAILCHIMP', 'SLACK', 'ALGOLIA',
  'PUSHER', 'GITHUB', 'GOOGLE', 'FIREBASE', 'DAILY', 'ZOOM', 'PAYPAL', 'LEMONSQUEEZY', 'PADDLE', 'CLOUDINARY', 'UPLOADTHING',
  'POSTHOG', 'SEGMENT', 'HUBSPOT', 'INNGEST', 'TRIGGER', 'LINEAR', 'NOTION', 'GROQ', 'MISTRAL', 'COHERE', 'REPLICATE',
]);

const IMAGES: Array<[RegExp, string]> = [
  [/^(redis|valkey|keydb|redis-stack|redis-stack-server)$/, 'redis'],
  [/^(minio|rustfs)$/, 's3'],
  [/^rabbitmq$/, 'rabbitmq'],
  [/^(kafka|cp-kafka|redpanda)$/, 'kafka'],
  [/^(elasticsearch|opensearch)$/, 'elasticsearch'],
  [/^(clickhouse|clickhouse-server)$/, 'clickhouse'],
  [/^(mailhog|mailpit|inbucket|smtp4dev|maildev)$/, 'smtp'],
  [/^localstack$/, 'aws'],
  [/^(mongo|mongodb)$/, 'mongodb'],
  [/^meilisearch$/, 'meilisearch'],
  [/^typesense$/, 'typesense'],
  [/^nats$/, 'nats'],
  [/^memcached$/, 'memcached'],
];

interface Hit {
  service: string;
  kind: Kind;
  evidence: string;
}

/** Hits from the dependencies of every workspace package.json. */
function dependencyHits(repoDir: string, packageDirs: string[]): Hit[] {
  return packageDirs.flatMap((dir) => {
    const file = relPath(repoDir, path.join(dir, 'package.json'));
    return dependencyNames(readPackageJson(dir)).flatMap((name) => {
      const known = PACKAGES[name];
      return known ? [{ service: known[0], kind: known[1], evidence: `dependency ${name} in ${file}` }] : [];
    });
  });
}

/** The service a committed dotenv key or its value points at, if any. */
function envService(key: string, value: string): [string, Kind] | null {
  const byKey = ENV_KEYS.find(([pattern]) => pattern.test(key));
  if (byKey) return [byKey[1], byKey[2]];
  const byScheme = URL_SCHEMES.find(([pattern]) => pattern.test(value));
  if (byScheme) return [byScheme[1], 'stateful'];
  const name = key.replace(BUILD_TIME_PREFIX, '');
  const credential = /^([A-Z0-9]+)_(?:\w+_)?(API_KEY|SECRET|SECRET_KEY|TOKEN|ACCESS_TOKEN)$/.exec(name);
  if (credential && THIRD_PARTIES.has(credential[1]!)) return [credential[1]!.toLowerCase(), 'third-party'];
  const apiKey = /^(\w+?)_API_KEY$/.exec(name);
  return apiKey ? [apiKey[1]!.toLowerCase(), 'third-party'] : null;
}

/** Hits from the keys (and URL values) of committed dotenv files in the repo and every workspace package. */
function envHits(repoDir: string, dirs: string[]): Hit[] {
  return envExampleEntries(repoDir, dirs).flatMap((entry) => {
    const service = envService(entry.key, entry.value);
    return service ? [{ service: service[0], kind: service[1], evidence: `${entry.key} in ${entry.file}` }] : [];
  });
}

/** Docker compose files in the repo, the workspace root, and their docker/ and .devcontainer/ directories. */
function composeFiles(dirs: string[]): string[] {
  const places = dirs.flatMap((dir) => [dir, path.join(dir, '.devcontainer'), path.join(dir, 'docker'), ...searchableSubdirs(path.join(dir, 'docker'))]);
  return [...new Set(places)].filter(isDir).flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => /^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/.test(name))
      .map((name) => path.join(dir, name)),
  );
}

/** Hits from the `image:` lines of compose files. */
function imageHits(repoDir: string, dirs: string[]): Hit[] {
  return composeFiles(dirs).flatMap((file) =>
    [...(readText(file) ?? '').matchAll(/^\s*image:\s*['"]?([^\s'"#]+)/gm)].flatMap((match) => {
      const image = match[1]!;
      const name = image.split('/').at(-1)!.split(/[:@]/)[0]!;
      const known = IMAGES.find(([pattern]) => pattern.test(name));
      return known ? [{ service: known[1], kind: 'stateful' as const, evidence: `image ${image} in ${relPath(repoDir, file)}` }] : [];
    }),
  );
}

/**
 * Scans the repo for services V1 does not isolate (D-012): dependencies in every workspace package.json, keys in
 * committed .env files, and compose service images. One entry per service, stateful if any evidence says so.
 */
export function scanUnmanaged(repoDir: string): UnmanagedService[] {
  const workspace = findWorkspace(repoDir);
  const dirs = [...new Set([repoDir, workspace.root, ...workspace.packageDirs])];
  const hits = [...dependencyHits(repoDir, workspace.packageDirs), ...envHits(repoDir, dirs), ...imageHits(repoDir, [...new Set([repoDir, workspace.root])])];
  const services = new Map<string, UnmanagedService>();
  for (const hit of hits) {
    const entry = services.get(hit.service) ?? { service: hit.service, kind: hit.kind, evidence: [] };
    if (hit.kind === 'stateful') entry.kind = 'stateful';
    if (!entry.evidence.includes(hit.evidence)) entry.evidence.push(hit.evidence);
    services.set(hit.service, entry);
  }
  return [...services.values()].sort((a, b) => a.service.localeCompare(b.service));
}

/** The warning line a run report carries for unmanaged services, or null if there are none. */
export function unmanagedWarning(services: UnmanagedService[]): string | null {
  if (services.length === 0) return null;
  const list = services.map((service) => `${service.service} (${service.kind})`).join(', ');
  const incomplete = services.some((service) => service.kind === 'stateful') ? '; isolation incomplete' : '';
  return `unmanaged services shared by every worker's app, not isolated (D-012): ${list}${incomplete}`;
}
