import type { Request, Response } from 'express';
import { escapeHtml, layout } from '../views.js';

/** GET /: the dashboard, greeting the signed-in user. */
export function showDashboard(_req: Request, res: Response): void {
  const name = res.locals.user?.name ?? '';
  res.send(
    layout(res.locals, {
      title: 'Dashboard',
      body: `<h1>Welcome, ${escapeHtml(name)}</h1>
      <p>Manage the <a href="/items">item list</a> or change <a href="/settings">settings</a>.</p>`,
    }),
  );
}
