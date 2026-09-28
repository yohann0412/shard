import type { NextFunction, Request, Response } from 'express';
import { query } from '../db.js';
import type { User } from '../locals.js';

/** Name of the cookie that holds the session id. */
export const SESSION_COOKIE = 'sid';

/** Returns the value of one cookie from the request's Cookie header, if present. */
function readCookie(req: Request, name: string): string | undefined {
  for (const pair of (req.get('cookie') ?? '').split(';')) {
    const [key, ...value] = pair.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

/** True for paths anyone may request without signing in. */
function isPublic(path: string): boolean {
  return path === '/signin' || path === '/health' || path.startsWith('/api/');
}

/** Loads the signed-in user into `res.locals.user`, and sends signed-out page requests to /signin. */
export async function loadSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionId = readCookie(req, SESSION_COOKIE);
  if (sessionId !== undefined) {
    const [user] = await query<User>(
      'select users.id, users.email, users.name from sessions join users on users.id = sessions.user_id where sessions.id = $1',
      [sessionId],
    );
    if (user !== undefined) {
      res.locals.user = user;
      res.locals.sessionId = sessionId;
    }
  }
  if (res.locals.user === undefined && !isPublic(req.path)) {
    res.redirect('/signin');
    return;
  }
  next();
}
