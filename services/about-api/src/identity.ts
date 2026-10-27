import type { ReactionSession } from '../../../src/lib/about/contracts';
import type { Env } from './env';

const encoder = new TextEncoder();
const encode = (value: Uint8Array): string =>
  btoa(String.fromCharCode(...value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
}
async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}
export async function hmac(secret: string, message: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(message))));
}

export async function createSession(env: Env, now = Date.now()): Promise<ReactionSession> {
  const expires = now + 90 * 24 * 60 * 60_000;
  const payload = encode(
    encoder.encode(JSON.stringify({ id: crypto.randomUUID(), exp: expires, env: env.ENVIRONMENT }))
  );
  const message = `v1.${payload}`;
  return {
    token: `${message}.${await hmac(env.VISITOR_SIGNING_SECRET!, message)}`,
    expiresAt: new Date(expires).toISOString(),
  };
}

export async function visitorFromToken(token: string | null, env: Env, now = Date.now()): Promise<string | null> {
  if (!token || token.length > 600 || !token.startsWith('Bearer ')) return null;
  try {
    const [version, payload, signature, extra] = token.slice(7).split('.');
    if (version !== 'v1' || !payload || !signature || extra !== undefined) return null;
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        await key(env.VISITOR_SIGNING_SECRET!),
        decode(signature),
        encoder.encode(`${version}.${payload}`)
      ))
    )
      return null;
    const data: unknown = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (!data || typeof data !== 'object') return null;
    const { id, exp, env: environment } = data as Record<string, unknown>;
    if (
      typeof id !== 'string' ||
      !UUID.test(id) ||
      typeof exp !== 'number' ||
      exp <= now ||
      environment !== env.ENVIRONMENT
    )
      return null;
    return hmac(env.VISITOR_SIGNING_SECRET!, `visitor:${id}`);
  } catch {
    return null;
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** IP is consumed only in memory; the native limiter sees an unlinkable daily HMAC. */
export async function abuseKey(request: Request, env: Env, now = Date.now()): Promise<string> {
  const day = Math.floor(now / 86_400_000);
  const dailyKey = await hmac(env.IP_HASH_SECRET!, `rate-limit-day:${day}`);
  return hmac(dailyKey, request.headers.get('CF-Connecting-IP') || 'unknown');
}
