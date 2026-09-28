import type { NextFunction, Request, Response } from 'express';
import { query } from '../db.js';

/** Reads the global maintenance setting from the database on every request into `res.locals.maintenance`. */
export async function loadMaintenance(_req: Request, res: Response, next: NextFunction): Promise<void> {
  const [setting] = await query<{ value: string }>("select value from settings where key = 'maintenance'");
  res.locals.maintenance = setting?.value === 'on';
  next();
}
