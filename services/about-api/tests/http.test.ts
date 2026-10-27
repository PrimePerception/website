import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, scheduled } from '../src/index';
import { testDatabase } from './database';
import { saveSample } from '../src/workbench';
import type { Env } from '../src/env';

function environment(): Env {
  return {
    ABOUT_DB: testDatabase().db,
    ENVIRONMENT: 'production',
    FIXTURES_ENABLED: 'false',
    ALLOWED_ORIGINS: 'https://primeperception.ca',
    VISITOR_SIGNING_SECRET: 'test-signing-secret-long-enough-for-production',
    IP_HASH_SECRET: 'test-ip-hash-secret-separate-and-long-enough',
    PUBLIC_LIMITER: { limit: async () => ({ success: true }) },
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
  };
}
const context = { waitUntil: () => undefined } as unknown as ExecutionContext;
function post(path: string, value: unknown = {}, origin = 'https://primeperception.ca', token?: string): Request {
  return new Request(`https://api.example${path}`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(value),
  });
}

test('status DTO is explicitly limited and public reads never call provider', async () => {
  const env = environment();
  await saveSample(env.ABOUT_DB, 72.3, Date.now(), true);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error('PROVIDER_SHOULD_NOT_BE_CALLED');
    };
    const response = await handleRequest(
      new Request('https://api.example/v1/workbench/status', { headers: { Origin: 'https://primeperception.ca' } }),
      env,
      context
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://primeperception.ca');
    assert.match(response.headers.get('Cache-Control')!, /public/);
    assert.deepEqual(Object.keys(await response.json()).sort(), [
      'lastUpdatedAt',
      'stale',
      'status',
      'trackingStartedAt',
      'utilizationPercent',
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test('write origins, request shape and tokens are enforced; only shared totals cache', async () => {
  const env = environment();
  assert.equal(
    (await handleRequest(post('/v1/reactions/session', {}, 'https://evil.example'), env, context)).status,
    403
  );
  assert.equal((await handleRequest(post('/v1/reactions/session', { extra: 1 }), env, context)).status, 400);
  const session = await handleRequest(post('/v1/reactions/session'), env, context);
  assert.equal(session.headers.get('Cache-Control'), 'no-store');
  const { token } = (await session.json()) as { token: string };
  const request = { kind: 'gg', requestId: crypto.randomUUID() };
  assert.equal((await handleRequest(post('/v1/reactions', request), env, context)).status, 403);
  const write = await handleRequest(post('/v1/reactions', request, undefined, token), env, context);
  assert.equal(write.status, 200);
  assert.equal(write.headers.get('Cache-Control'), 'no-store');
  assert.equal(
    (
      await handleRequest(
        post('/v1/reactions', { ...request, requestId: crypto.randomUUID() }, undefined, token),
        env,
        context
      )
    ).status,
    429
  );
  const totals = await handleRequest(new Request('https://api.example/v1/reactions'), env, context);
  assert.equal(totals.headers.get('Cache-Control'), 'public, max-age=15');
  assert.deepEqual(await totals.json(), { counts: { gg: 1, 'touch-grass': 0, shower: 0, league: 0 } });
});

test('generic errors cannot leak database or provider details; fixture hosts are loopback-only', async () => {
  const env = environment();
  env.ABOUT_DB = {
    prepare: () => {
      throw new Error('PRIVATE_PROVIDER_NAMES_AND_KEY');
    },
  } as unknown as D1Database;
  const failed = await handleRequest(new Request('https://api.example/v1/workbench/status'), env, context);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'unavailable' });
  assert.equal(failed.headers.get('Cache-Control'), 'no-store');
  env.ENVIRONMENT = 'local';
  env.FIXTURES_ENABLED = 'true';
  assert.equal(
    (await handleRequest(new Request('https://remote.example/v1/workbench/status'), env, context)).status,
    503
  );
  env.ENVIRONMENT = 'production';
  assert.equal((await handleRequest(new Request('https://api.example/v1/reactions'), env, context)).status, 503);
});

test('history validates bounded ranges and coarse IP limiter returns generic rate responses', async () => {
  const env = environment();
  for (const query of ['range=100y', 'foo=x', 'range=24h&range=7d', 'range=24h&foo=x'])
    assert.equal(
      (await handleRequest(new Request(`https://api.example/v1/workbench/history?${query}`), env, context)).status,
      400
    );
  env.PUBLIC_LIMITER = { limit: async () => ({ success: false }) };
  const response = await handleRequest(new Request('https://api.example/v1/reactions'), env, context);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'rate_limited', retryAfter: 60 });
});

test('native cache keys retain request origin and normalize the default history range', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const stored = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  const cacheContext = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as ExecutionContext;
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      default: {
        match: async (request: Request) => stored.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          stored.set(request.url, response.clone());
        },
      },
    },
  });
  try {
    const first = environment();
    const second = environment();
    await saveSample(first.ABOUT_DB, 20, Date.now(), true);
    await saveSample(second.ABOUT_DB, 80, Date.now(), true);
    const readOne = await handleRequest(new Request('https://one.example/v1/workbench/status'), first, cacheContext);
    const readTwo = await handleRequest(new Request('https://two.example/v1/workbench/status'), second, cacheContext);
    assert.equal(((await readOne.json()) as { utilizationPercent: number }).utilizationPercent, 20);
    assert.equal(((await readTwo.json()) as { utilizationPercent: number }).utilizationPercent, 80);
    await handleRequest(new Request('https://one.example/v1/workbench/history'), first, cacheContext);
    await handleRequest(new Request('https://one.example/v1/workbench/history?range=24h'), first, cacheContext);
    await Promise.all(pending);
    assert.deepEqual([...stored.keys()].sort(), [
      'https://one.example/v1/workbench/history?range=24h',
      'https://one.example/v1/workbench/status',
      'https://two.example/v1/workbench/status',
    ]);
  } finally {
    if (original) Object.defineProperty(globalThis, 'caches', original);
    else Reflect.deleteProperty(globalThis, 'caches');
  }
});

test('reaction cleanup runs independently when the conference cron fails', async () => {
  const { db, sqlite } = testDatabase();
  const now = Date.parse('2026-10-27T17:30:20Z');
  sqlite
    .prepare('INSERT INTO reaction_events(visitor, request_id, kind, created_at, utc_day) VALUES(?, ?, ?, ?, ?)')
    .run('expired', crypto.randomUUID(), 'gg', now - 2 * 86_400_000 - 1, 0);
  const env = { ...environment(), ABOUT_DB: db };
  const pending: Promise<unknown>[] = [];
  await scheduled({ cron: '17 8 * * *', scheduledTime: now } as ScheduledController, env, {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as unknown as ExecutionContext);
  // The absent conference table makes conference refresh fail, independently of cleanup.
  assert.equal(pending.length, 2);
  await Promise.all(pending);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM reaction_events').get()?.count, 0);
  assert.equal(sqlite.prepare("SELECT total FROM reaction_totals WHERE kind='gg'").get()?.total, 1);
});
