import type { User } from './locals.js';

/** What a route passes to the layout: the page's title, its HTML body and its own scripts. */
export interface Page {
  title: string;
  body: string;
  scripts?: string[];
}

/** Escapes text for use inside HTML elements and attribute values. */
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** Renders a full HTML document: nav, the maintenance banner when it is on, the page body and scripts. */
export function layout(locals: { user?: User; maintenance?: boolean }, page: Page): string {
  const nav = locals.user
    ? `<a href="/">Home</a> <a href="/items">Items</a> <a href="/settings">Settings</a>
       <form method="post" action="/signout" class="inline"><button type="submit">Sign out</button></form>`
    : '<a href="/signin">Sign in</a>';
  const banner = locals.maintenance ? '<p class="banner" role="status">Maintenance mode is on</p>' : '';
  const scripts = ['/js/common.js', ...(page.scripts ?? [])].map((src) => `<script src="${src}"></script>`).join('\n    ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(page.title)} · Fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
      nav a[aria-current="page"] { font-weight: bold; }
      .inline { display: inline; }
      .banner { background: #fde68a; padding: 0.5rem 1rem; }
      .error { color: #b91c1c; }
    </style>
  </head>
  <body>
    <nav>${nav}</nav>
    ${banner}
    <main>
${page.body}
    </main>
    ${scripts}
  </body>
</html>
`;
}
