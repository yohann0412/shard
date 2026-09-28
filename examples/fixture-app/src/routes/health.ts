import type { Request, Response } from 'express';
import { currentDatabase } from '../db.js';

/** GET /health: `{ ok: true, database }`, where database is the connected database's name. */
export async function health(_req: Request, res: Response): Promise<void> {
  res.json({ ok: true, database: await currentDatabase() });
}
