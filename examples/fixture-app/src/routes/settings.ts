import type { Request, Response } from 'express';
import { query } from '../db.js';
import { layout } from '../views.js';

/** GET /settings: the current maintenance mode and a button that flips it. */
export function showSettings(_req: Request, res: Response): void {
  const mode = res.locals.maintenance ? 'on' : 'off';
  const next = res.locals.maintenance ? 'off' : 'on';
  res.send(
    layout(res.locals, {
      title: 'Settings',
      body: `<h1>Settings</h1>
      <p id="maintenance-mode">Maintenance: ${mode}</p>
      <form id="maintenance-form" method="post" action="/settings/maintenance">
        <input type="hidden" name="mode" value="${next}">
        <button type="submit">Turn maintenance ${next}</button>
      </form>`,
      scripts: ['/js/settings.js'],
    }),
  );
}

/** POST /settings/maintenance: sets the global maintenance mode to `on` or `off`. */
export async function setMaintenance(req: Request, res: Response): Promise<void> {
  const mode = String(req.body?.mode ?? '');
  if (mode !== 'on' && mode !== 'off') {
    res.status(400).send('mode must be "on" or "off"');
    return;
  }
  await query(
    "insert into settings (key, value) values ('maintenance', $1) on conflict (key) do update set value = excluded.value",
    [mode],
  );
  res.redirect('/settings');
}
