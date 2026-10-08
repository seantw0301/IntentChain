import crypto from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { purgeIdleSessions, touchSession } from './db';

const COOKIE = 'ic_session';

/**
 * Every browser gets its own isolated demo state. The id is random, lives in
 * an HttpOnly cookie, and every row in the database is keyed by it.
 */
export async function sessionId(): Promise<string> {
  const jar = await cookies();
  let id = jar.get(COOKIE)?.value;
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    id = crypto.randomBytes(16).toString('hex');
    const h = await headers();
    jar.set(COOKIE, id, {
      httpOnly: true,
      sameSite: 'lax', // the PayPal approval redirect must bring the cookie back
      secure: h.get('x-forwarded-proto') === 'https',
      path: '/intentchain',
      maxAge: 24 * 3600,
    });
    if (Math.random() < 0.1) purgeIdleSessions();
  }
  touchSession(id);
  return id;
}

/** Public origin of this deployment, used to build the PayPal return URL. */
export async function publicOrigin(): Promise<string> {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, '');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3100';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}
