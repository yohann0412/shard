// Written by the experiment harness from experiments/recipes/rallly.json.
export default {
  "packageManager": "pnpm",
  "db": {
    "migrate": "pnpm -w run db:deploy",
    "urlEnv": "DATABASE_URL",
    "extraUrlEnvs": [
      "DIRECT_DATABASE_URL"
    ]
  },
  "app": {
    "start": "pnpm exec next start --port \"$PORT\"",
    "portEnv": "PORT",
    "healthPath": "/api/status",
    "env": {
      "NEXT_PUBLIC_BASE_URL": "{origin}",
      "__NEXT_PROCESSED_ENV": "true",
      "NODE_ENV": "test",
      "CRON_SECRET": "1234567890abcdef1234567890abcdef1234",
      "HIDE_DEV_INDICATOR": "true",
      "INITIAL_ADMIN_EMAIL": "initial.admin@rallly.co",
      "QUICK_CREATE_ENABLED": "true",
      "RATE_LIMIT_ENABLED": "false",
      "SCHEDULED_EVENTS_ENABLED": "true",
      "SECRET_PASSWORD": "abcdef1234567890abcdef1234567890",
      "SMTP_REJECT_UNAUTHORIZED": "false",
      "SMTP_PORT": "323{i}",
      "SUPPORT_EMAIL": "support@rallly.co",
      "WEBHOOK_ALLOW_PRIVATE_URLS": "true",
      "CONFERENCING_ENABLED": "true",
      "ZOOM_CLIENT_ID": "test-zoom",
      "ZOOM_CLIENT_SECRET": "test-zoom-secret",
      "ZOOM_WEBHOOK_SECRET_TOKEN": "test-zoom-webhook-secret"
    },
    "bootTimeoutMs": 120000
  },
  "playwright": {
    "config": "playwright.config.ts",
    "baseUrlEnvs": [
      "BASE_URL"
    ],
    "env": {
      "MAILPIT_API_URL": "http://127.0.0.1:324{i}/api"
    },
    "sharedOrigin": "http://localhost:3201"
  },
  "postgres": {},
  "cache": {
    "inputs": []
  },
  "unmanaged": {
    "allow": true,
    "services": [
      "mailpit: SMTP 127.0.0.1:3225 (SMTP_HOST/SMTP_PORT, app) + HTTP API 127.0.0.1:3226 (MAILPIT_API_URL, tests)"
    ]
  },
  "trace": {
    "clientRoots": []
  }
};
