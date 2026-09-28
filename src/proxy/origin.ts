/** The origin an app's build baked in, which the shared-origin proxy listens on (DECISIONS D-014). */
export interface SharedOrigin {
  /** Normalized origin without a trailing slash, e.g. `http://localhost:3201`: the browser-facing base URL. */
  href: string;
  /** Host name or IP address to listen on, without IPv6 brackets. */
  hostname: string;
  port: number;
}

/** Parses `--shared-origin` or `playwright.sharedOrigin`; throws a message for the user if it is not a plain http origin. */
export function parseSharedOrigin(value: string): SharedOrigin {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--shared-origin must be a URL such as http://localhost:3201 (got ${value})`);
  }
  if (url.protocol !== 'http:') throw new Error(`--shared-origin must use http: the proxy does not terminate TLS (got ${value})`);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error(`--shared-origin must be an origin only, scheme, host and port, without a path (got ${value})`);
  }
  return { href: url.origin, hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(url.port || 80) };
}
