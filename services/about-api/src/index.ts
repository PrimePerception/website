import {
  HISTORY_RANGES,
  REACTION_KINDS,
  type HistoryRange,
  type ReactionKind,
  type PublicApiError,
} from '../../../src/lib/about/contracts';
import { getConferenceFeed, updateConferences } from './conferences';
import { type Env, isLocalFixture, validConfiguration } from './env';
import { abuseKey, createSession, UUID, visitorFromToken } from './identity';
import { addReaction, getCounts, pruneReactionEvents } from './reactions';
import { collectUtilization } from './runpod';
import { getHistory, getStatus, saveSample } from './workbench';

function json(value: unknown, status = 200, cacheSeconds = 0): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
function error(error: PublicApiError['error'], status: number, retryAfter?: number): Response {
  const response = json({ error, ...(retryAfter ? { retryAfter } : {}) }, status);
  if (retryAfter) response.headers.set('Retry-After', String(retryAfter));
  return response;
}
const loopback = (hostname: string): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
function allowedOrigins(env: Env): Set<string> {
  return new Set(
    env.ALLOWED_ORIGINS.split(',').filter((origin) => {
      try {
        const url = new URL(origin);
        return (
          url.origin === origin &&
          (url.protocol === 'https:' || (env.ENVIRONMENT === 'local' && loopback(url.hostname)))
        );
      } catch {
        return false;
      }
    })
  );
}
function withCors(response: Response, origin: string | null, allowed: Set<string>, fixtures: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set('Vary', 'Origin');
  if (origin && allowed.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    headers.set('Access-Control-Expose-Headers', 'Retry-After');
  }
  if (fixtures) headers.set('X-About-Fixtures', 'true');
  return new Response(response.body, { status: response.status, headers });
}
async function body(request: Request): Promise<Record<string, unknown> | null> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return null;
  if (Number(request.headers.get('Content-Length')) > 1024 || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > 1024) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function publicRead(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== '/v1/workbench/history' && url.search) return error('invalid_request', 400);
  const range = url.searchParams.get('range') ?? '24h';
  if (
    path === '/v1/workbench/history' &&
    (url.searchParams.size > 1 ||
      [...url.searchParams.keys()].some((key) => key !== 'range') ||
      !HISTORY_RANGES.includes(range as HistoryRange))
  )
    return error('invalid_request', 400);
  const cache = typeof caches === 'undefined' ? undefined : caches.default;
  const cacheKey = new Request(`${url.origin}${path}${path.endsWith('/history') ? `?range=${range}` : ''}`);
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;
  let response: Response;
  if (path === '/v1/workbench/status') {
    const status = await getStatus(env.ABOUT_DB);
    const remaining =
      status.lastUpdatedAt && !status.stale
        ? Math.floor((Date.parse(status.lastUpdatedAt) + 180_000 - Date.now()) / 1000)
        : 30;
    response = json(status, 200, Math.max(1, Math.min(30, remaining)));
  } else if (path === '/v1/workbench/history') {
    response = json(await getHistory(env.ABOUT_DB, range as HistoryRange), 200, 300);
  } else if (path === '/v1/reactions') {
    response = json({ counts: await getCounts(env.ABOUT_DB) }, 200, 15);
  } else if (path === '/v1/conferences') {
    response = json(await getConferenceFeed(env.ABOUT_DB), 200, 300);
  } else return error('not_found', 404);
  if (cache) context.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
  return response;
}

export async function handleRequest(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const fixtures = isLocalFixture(env);
  const allowed = allowedOrigins(env);
  const origin = request.headers.get('Origin');
  const finish = (response: Response): Response => withCors(response, origin, allowed, fixtures);
  try {
    if (!validConfiguration(env) || (fixtures && !loopback(url.hostname))) return finish(error('unavailable', 503));
    if (request.method === 'OPTIONS') {
      if (!origin || !allowed.has(origin)) return finish(error('forbidden', 403));
      return finish(
        new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'Access-Control-Max-Age': '600' } })
      );
    }
    const key = await abuseKey(request, env);
    if (!(await env.PUBLIC_LIMITER.limit({ key })).success) return finish(error('rate_limited', 429, 60));
    if (request.method === 'GET') return finish(await publicRead(request, env, context));
    if (request.method !== 'POST') return finish(error('not_found', 404));
    if (!origin || !allowed.has(origin)) return finish(error('forbidden', 403));
    if (!(await env.WRITE_LIMITER.limit({ key })).success) return finish(error('rate_limited', 429, 60));
    if (url.search) return finish(error('invalid_request', 400));
    const input = await body(request);
    if (!input) return finish(error('invalid_request', 400));
    if (url.pathname === '/v1/reactions/session') {
      if (Object.keys(input).length) return finish(error('invalid_request', 400));
      return finish(json(await createSession(env)));
    }
    if (url.pathname !== '/v1/reactions') return finish(error('not_found', 404));
    const { kind, requestId } = input;
    if (
      Object.keys(input).length !== 2 ||
      !REACTION_KINDS.includes(kind as ReactionKind) ||
      typeof requestId !== 'string' ||
      !UUID.test(requestId)
    )
      return finish(error('invalid_request', 400));
    const visitor = await visitorFromToken(request.headers.get('Authorization'), env);
    if (!visitor) return finish(error('forbidden', 403));
    const result = await addReaction(env.ABOUT_DB, visitor, kind as ReactionKind, requestId);
    if ('invalid' in result) return finish(error('invalid_request', 400));
    if (result.retryAfter) return finish(error('rate_limited', 429, result.retryAfter));
    return finish(json(result.receipt));
  } catch {
    // Do not serialize/log exception messages, which may contain upstream or database details.
    return finish(error('unavailable', 503));
  }
}

export async function scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
  if (env.ENVIRONMENT !== 'production' || env.FIXTURES_ENABLED !== 'false') return;
  const now = controller.scheduledTime;
  if (!['* * * * *', '17 8 * * *'].includes(controller.cron)) return;
  context.waitUntil(pruneReactionEvents(env.ABOUT_DB, now).catch(() => undefined));
  if (controller.cron === '17 8 * * *') {
    context.waitUntil(updateConferences(env.ABOUT_DB, now).catch(() => undefined));
    return;
  }
  if (controller.cron !== '* * * * *') return;
  context.waitUntil(
    (async () => {
      const percent = await collectUtilization(env.RUNPOD_API_KEY, now);
      await saveSample(env.ABOUT_DB, percent, now, true);
    })().catch(() => undefined)
  );
}

export default { fetch: handleRequest, scheduled } satisfies ExportedHandler<Env>;
