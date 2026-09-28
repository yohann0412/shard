import type { Request, Response } from 'express';
import { query } from '../db.js';
import { escapeHtml, layout } from '../views.js';

interface Item {
  id: number;
  name: string;
  created_at: Date;
}

/** Returns every item, newest first. */
async function newestItems(): Promise<Item[]> {
  return query<Item>('select id, name, created_at from items order by created_at desc, id desc');
}

/** GET /items: the item list with its count, a filter box, and the create form unless maintenance is on. */
export async function listItems(_req: Request, res: Response): Promise<void> {
  const items = await newestItems();
  const rows = items.map((item) => `<li>${escapeHtml(item.name)}</li>`).join('\n        ');
  const create = res.locals.maintenance
    ? '<p class="notice">Item creation is disabled during maintenance.</p>'
    : `<form method="post" action="/items">
        <label>New item <input name="name" required></label>
        <button type="submit">Add item</button>
      </form>`;
  res.send(
    layout(res.locals, {
      title: 'Items',
      body: `<h1>Items</h1>
      <p id="item-count">${items.length} items</p>
      ${create}
      <p><label>Filter <input id="item-filter" type="search"></label></p>
      <ul id="items">
        ${rows}
      </ul>`,
      scripts: ['/js/items.js'],
    }),
  );
}

/** POST /items: adds an item and redirects to the list; answers 503 while maintenance is on. */
export async function createItem(req: Request, res: Response): Promise<void> {
  if (res.locals.maintenance) {
    res.status(503).send(
      layout(res.locals, { title: 'Items', body: '<h1>Items</h1>\n      <p class="error" role="alert">Item creation is disabled during maintenance.</p>' }),
    );
    return;
  }
  const name = String(req.body?.name ?? '').trim();
  if (name === '') {
    res.status(400).send('name is required');
    return;
  }
  await query('insert into items (name) values ($1)', [name]);
  res.redirect('/items');
}

/** GET /api/items: every item as JSON, newest first. */
export async function listItemsApi(_req: Request, res: Response): Promise<void> {
  res.json(await newestItems());
}
