import { appFiles, appPackages, capped, COMPOSE_FILE, composeImages, dependencies, ENV_EXAMPLE, envKeys } from './patterns.js';
import type { RepoSnapshot } from './repo.js';
import type { Service } from './schema.js';

/** How one service or third-party API shows up in dependencies, compose images and env keys. */
interface ServiceRule {
  name: string;
  kind: Service['kind'];
  dependency: RegExp | null;
  image: RegExp | null;
  env: RegExp | null;
}

/** An env key the e2e setup reads, and whether it fails without it. */
interface E2EKey {
  file: string;
  key: string;
  required: boolean;
}

const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|NEXT_PRIVATE_|VITE_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_|NUXT_|EXPO_PUBLIC_)/;
const E2E_ENV_FILE = /(^|\/)(e2e|playwright|tests?|integration)[\w-]*\/|(^|\/)\.env([.-]\w+)*[.-](test|e2e|ci|playwright)([.-]\w+)*$/i;
const ENV_READ = /process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g;
const REQUIRED_READ = [
  /process\.env\.([A-Z][A-Z0-9_]+)!/g,
  /if\s*\(\s*!\s*process\.env\.([A-Z][A-Z0-9_]+)\s*\)\s*\{?\s*throw\b/g,
  /\b\w*(?:[Rr]equire|[Mm]ust)\w*Env\w*\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
];

const SERVICE_RULES: ServiceRule[] = [
  { name: 'redis', kind: 'service', dependency: /^(redis|ioredis|@redis\/client|@upstash\/redis|connect-redis|rate-limit-redis|cache-manager-redis-store|cache-manager-ioredis-yet|@keyv\/redis)$/, image: /(^|\/)(redis|valkey|dragonfly|keydb)|redis-stack/i, env: /^(REDIS|UPSTASH_REDIS|VALKEY|KV_REST)/ },
  { name: 's3/minio', kind: 'service', dependency: /^(@aws-sdk\/client-s3|@aws-sdk\/lib-storage|@aws-sdk\/s3-request-presigner|minio|@google-cloud\/storage|@azure\/storage-blob)$/, image: /minio|localstack|seaweedfs/i, env: /^(S3_|MINIO_|AWS_S3|STORAGE_S3)|S3_BUCKET|_BUCKET(_NAME)?$/ },
  { name: 'queue: bullmq', kind: 'service', dependency: /^(bullmq|bull|bee-queue|@nestjs\/bull|@nestjs\/bullmq)$/, image: null, env: null },
  { name: 'queue: kafka', kind: 'service', dependency: /^(kafkajs|@confluentinc\/kafka-javascript|node-rdkafka)$/, image: /kafka|redpanda/i, env: /^KAFKA_/ },
  { name: 'queue: rabbitmq', kind: 'service', dependency: /^(amqplib|amqp-connection-manager|@golevelup\/nestjs-rabbitmq)$/, image: /rabbitmq/i, env: /^(RABBITMQ_|AMQP_)/ },
  { name: 'queue: sqs', kind: 'service', dependency: /^(@aws-sdk\/client-sqs|sqs-consumer)$/, image: null, env: /^(AWS_)?SQS_/ },
  { name: 'queue: nats', kind: 'service', dependency: /^nats$/, image: /(^|\/)nats(:|$)/i, env: /^NATS_/ },
  { name: 'clickhouse', kind: 'service', dependency: /^(@clickhouse\/client|@clickhouse\/client-web|clickhouse)$/, image: /clickhouse/i, env: /^CLICKHOUSE_/ },
  { name: 'search: elasticsearch', kind: 'service', dependency: /^@elastic\/elasticsearch$/, image: /elasticsearch/i, env: /^ELASTIC(SEARCH)?_/ },
  { name: 'search: opensearch', kind: 'service', dependency: /^@opensearch-project\/opensearch$/, image: /opensearch/i, env: /^OPENSEARCH_/ },
  { name: 'search: meilisearch', kind: 'service', dependency: /^meilisearch$/, image: /meilisearch/i, env: /^MEILI/ },
  { name: 'search: typesense', kind: 'service', dependency: /^typesense$/, image: /typesense/i, env: /^TYPESENSE_/ },
  { name: 'mongodb', kind: 'service', dependency: /^(mongodb|mongoose)$/, image: /(^|\/)mongo(:|$)/i, env: /^MONGO/ },
  { name: 'smtp/mail', kind: 'service', dependency: /^(nodemailer|@nestjs-modules\/mailer|emailjs)$/, image: /mailhog|mailpit|maildev|smtp4dev|inbucket|mailcatcher|greenmail|mailcrab/i, env: /^(EMAIL_SERVER|MAIL_HOST|MAILER_)|SMTP/ },
  { name: 'stripe', kind: 'third-party', dependency: /^(stripe|@stripe\/stripe-js)$/, image: /stripe-mock/i, env: /^STRIPE/ },
  { name: 'openai', kind: 'third-party', dependency: /^(openai|@ai-sdk\/openai|@langchain\/openai)$/, image: null, env: /^OPENAI/ },
  { name: 'anthropic', kind: 'third-party', dependency: /^(@anthropic-ai\/sdk|@ai-sdk\/anthropic)$/, image: null, env: /^ANTHROPIC/ },
  { name: 'resend', kind: 'third-party', dependency: /^resend$/, image: null, env: /^RESEND/ },
  { name: 'sendgrid', kind: 'third-party', dependency: /^@sendgrid\/mail$/, image: null, env: /^SENDGRID/ },
  { name: 'twilio', kind: 'third-party', dependency: /^twilio$/, image: null, env: /^TWILIO/ },
  { name: 'postmark', kind: 'third-party', dependency: /^postmark$/, image: null, env: /^POSTMARK/ },
  { name: 'mailgun', kind: 'third-party', dependency: /^(mailgun\.js|mailgun-js)$/, image: null, env: /^MAILGUN/ },
  { name: 'google oauth', kind: 'third-party', dependency: null, image: null, env: /^GOOGLE_CLIENT_/ },
  { name: 'github oauth', kind: 'third-party', dependency: null, image: null, env: /^GITHUB_CLIENT_/ },
  { name: 'aws', kind: 'third-party', dependency: /^(aws-sdk|@aws-sdk\/client-(ses|sesv2|sns|lambda|cloudfront|secrets-manager|kms|cognito-identity-provider))$/, image: null, env: /^AWS_(?!S3)/ },
];

/**
 * Env keys the e2e setup reads: `process.env.X` in the Playwright config and its local imports (required when read
 * with `!`, guarded by a throw, or passed to a require/must-style env helper), plus keys of e2e-specific env examples.
 */
function e2eKeys(repo: RepoSnapshot, e2eSources: Array<[string, string]>): E2EKey[] {
  const keys: E2EKey[] = [];
  for (const [file, text] of e2eSources) {
    const required = new Set(REQUIRED_READ.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1] ?? '')));
    for (const match of text.matchAll(ENV_READ)) {
      const key = match[1] ?? match[2] ?? '';
      keys.push({ file, key, required: required.has(key) });
    }
    for (const key of required) keys.push({ file, key, required: true });
  }
  for (const [file, text] of appFiles(repo, ENV_EXAMPLE).filter(([p]) => E2E_ENV_FILE.test(p))) {
    keys.push(...envKeys(text).map(({ key }) => ({ file, key, required: false })));
  }
  return keys;
}

/**
 * Services and third-party APIs besides Postgres that the app appears to use, from dependencies, compose images and
 * env-example keys; `referencedByE2E` when the e2e setup reads their keys, `requiredByE2E` when it fails without them.
 */
export function detectServices(repo: RepoSnapshot, e2eSources: Array<[string, string]>): Service[] {
  const packages = appPackages(repo);
  const composeFiles = appFiles(repo, COMPOSE_FILE).map(([p, text]) => [p, composeImages(text)] as const);
  const envFiles = appFiles(repo, ENV_EXAMPLE).map(([p, text]) => [p, envKeys(text).map(({ key }) => key)] as const);
  const e2e = e2eKeys(repo, e2eSources);
  const services: Service[] = [];
  for (const rule of SERVICE_RULES) {
    const { dependency, image, env } = rule;
    const matchesEnv = (key: string) => env !== null && env.test(key.replace(PUBLIC_PREFIX, ''));
    const evidence = [
      ...(dependency ? packages.flatMap(([p, m]) => dependencies(m).filter((d) => dependency.test(d)).map((d) => `${p}: dependency ${d}`)) : []),
      ...(image ? composeFiles.flatMap(([p, images]) => images.filter((i) => image.test(i)).map((i) => `${p}: image ${i}`)) : []),
      ...envFiles.flatMap(([p, keys]) => keys.filter(matchesEnv).map((key) => `${p}: ${key}`)),
    ];
    const read = e2e.filter(({ key }) => matchesEnv(key)).sort((a, b) => Number(b.required) - Number(a.required));
    if (evidence.length === 0 && read.length === 0) continue;
    const readEvidence = read.map(({ file, key, required }) => `${file}: ${key} (${required ? 'required' : 'read'} by e2e setup)`);
    services.push({
      name: rule.name,
      kind: rule.kind,
      evidence: capped([...readEvidence, ...evidence]),
      referencedByE2E: read.length > 0,
      requiredByE2E: read.some(({ required }) => required),
    });
  }
  return services;
}
