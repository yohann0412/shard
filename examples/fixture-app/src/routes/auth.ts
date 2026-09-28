import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { query } from '../db.js';
import { SESSION_COOKIE } from '../middleware/session.js';
import { escapeHtml, layout } from '../views.js';

/** Renders the sign-in form, with an error line when one is given. */
function signInPage(res: Response, email: string, error?: string): string {
  const message = error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>`;
  return layout(res.locals, {
    title: 'Sign in',
    body: `<h1>Sign in</h1>
      ${message}
      <form method="post" action="/signin">
        <p><label>Email <input name="email" type="email" value="${escapeHtml(email)}" required></label></p>
        <p><label>Password <input name="password" type="password" required></label></p>
        <button type="submit">Sign in</button>
      </form>`,
  });
}

/** GET /signin: the sign-in form. */
export function showSignIn(_req: Request, res: Response): void {
  res.send(signInPage(res, ''));
}

/** POST /signin: checks email and password, starts a session and redirects to the dashboard. */
export async function signIn(req: Request, res: Response): Promise<void> {
  const email = String(req.body?.email ?? '');
  const password = String(req.body?.password ?? '');
  const [user] = await query<{ id: number; password: string }>('select id, password from users where email = $1', [email]);
  if (user === undefined || user.password !== password) {
    res.status(401).send(signInPage(res, email, 'Invalid email or password'));
    return;
  }
  const sessionId = randomUUID();
  await query('insert into sessions (id, user_id) values ($1, $2)', [sessionId, user.id]);
  res.cookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'lax', path: '/' });
  res.redirect('/');
}

/** POST /signout: ends the current session and redirects to the sign-in form. */
export async function signOut(_req: Request, res: Response): Promise<void> {
  await query('delete from sessions where id = $1', [res.locals.sessionId]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.redirect('/signin');
}
