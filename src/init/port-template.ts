const HOST = String.raw`(localhost|127\.0\.0\.1|0\.0\.0\.0)`;

/**
 * Replaces the app's literal port in a command or env value with the placeholders isolate fills per worker:
 * `http://localhost:3000` → `{url}`, `localhost:3000` → `localhost:{port}`, `-p 3000`, `--port 3000`, `--port=3000`
 * and `PORT=3000` → `{port}`, and a value that is just `3000` → `{port}`.
 */
export function templatePort(text: string, port: number | null): string {
  if (port === null) return text;
  if (text === String(port)) return '{port}';
  return text
    .replace(new RegExp(String.raw`http://${HOST}:${port}(?!\d)`, 'g'), '{url}')
    .replace(new RegExp(String.raw`${HOST}:${port}(?!\d)`, 'g'), '$1:{port}')
    .replace(new RegExp(String.raw`(^|\s)(-p|--port)(\s+|=)${port}(?!\d)`, 'g'), '$1$2$3{port}')
    .replace(new RegExp(String.raw`\b(\w*PORT)=${port}(?!\d)`, 'g'), '$1={port}');
}
