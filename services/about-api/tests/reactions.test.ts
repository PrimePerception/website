import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addReaction, DAY, getCounts, INSERT_REACTION, insertBindings, pruneReactionEvents } from '../src/reactions';
import { abuseKey, createSession, visitorFromToken } from '../src/identity';
import type { Env } from '../src/env';
import { testDatabase } from './database';

const now = Date.parse('2026-10-27T17:30:20Z');
const identityEnv = {
  ENVIRONMENT: 'production',
  VISITOR_SIGNING_SECRET: 'test-signing-secret-32-characters-long',
  IP_HASH_SECRET: 'test-ip-secret-that-is-separate-and-long',
} as Env;

test('signed identities reject tampering, expiry, and cross-environment tokens', async () => {
  const session = await createSession(identityEnv, now);
  const token = `Bearer ${session.token}`;
  const visitor = await visitorFromToken(token, identityEnv, now);
  assert.ok(visitor);
  assert.equal(await visitorFromToken(token, identityEnv, now + 91 * DAY), null);
  assert.equal(await visitorFromToken(`${token.slice(0, -5)}other`, identityEnv, now), null);
  assert.equal(await visitorFromToken(token, { ...identityEnv, ENVIRONMENT: 'local' }, now), null);
  assert.equal(await visitorFromToken(token, identityEnv, now), visitor);
  const request = new Request('https://api.example', { headers: { 'CF-Connecting-IP': '192.0.2.5' } });
  const first = await abuseKey(request, identityEnv, now);
  assert.notEqual(first, '192.0.2.5');
  assert.notEqual(await abuseKey(request, identityEnv, now + DAY), first);
});

test('duplicate retries increment once, reject changed kind, and use server cooldown', async () => {
  const { db } = testDatabase();
  const id = randomUUID();
  const accepted = await addReaction(db, 'visitor', 'gg', id, now);
  assert.ok('receipt' in accepted && accepted.receipt?.accepted);
  assert.equal(accepted.receipt?.duplicate, false);
  const duplicate = await addReaction(db, 'visitor', 'gg', id, now + 1);
  assert.equal(duplicate.receipt?.duplicate, true);
  assert.equal((await getCounts(db)).gg, 1);
  assert.deepEqual(await addReaction(db, 'visitor', 'shower', id, now + 1), { invalid: true });
  assert.deepEqual(await addReaction(db, 'visitor', 'gg', randomUUID(), now + 10_000), { retryAfter: 50 });
  assert.ok((await addReaction(db, 'visitor', 'shower', randomUUID(), now)).receipt);
  assert.ok((await addReaction(db, 'other-visitor', 'gg', randomUUID(), now)).receipt);
});

test('20 daily cap resets midnight UTC while cooldown crosses midnight', async () => {
  const { db } = testDatabase();
  const midnight = Math.floor(now / DAY) * DAY;
  for (let index = 0; index < 20; index++)
    assert.ok((await addReaction(db, 'visitor', 'gg', randomUUID(), midnight + index * 60_000)).receipt);
  const denied = await addReaction(db, 'visitor', 'gg', randomUUID(), midnight + 21 * 60_000);
  assert.equal(denied.retryAfter, (DAY - 21 * 60_000) / 1000);
  assert.ok((await addReaction(db, 'visitor', 'gg', randomUUID(), midnight + DAY)).receipt);
  await addReaction(db, 'late-visitor', 'league', randomUUID(), midnight + DAY - 10_000);
  assert.equal((await addReaction(db, 'late-visitor', 'league', randomUUID(), midnight + DAY)).retryAfter, 50);
});

test('failed trigger transaction cannot leave an event without its counter increment', async () => {
  const { db, sqlite } = testDatabase();
  sqlite.exec(
    `CREATE TRIGGER fail_counter BEFORE UPDATE ON reaction_totals BEGIN SELECT RAISE(ABORT, 'test failure'); END;`
  );
  await assert.rejects(addReaction(db, 'visitor', 'gg', randomUUID(), now));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM reaction_events').get()?.count, 0);
  assert.equal((await getCounts(db)).gg, 0);
});

test('missing shared totals fail rather than fabricate a zero counter', async () => {
  const { db, sqlite } = testDatabase();
  sqlite.exec("DELETE FROM reaction_totals WHERE kind='gg'");
  await assert.rejects(getCounts(db));
});

test('48-hour event pruning preserves permanent totals, current limits and the idempotency boundary', async () => {
  const { db, sqlite } = testDatabase();
  const expiredId = randomUUID();
  const boundaryId = randomUUID();
  await addReaction(db, 'expired', 'gg', expiredId, now - 2 * DAY - 1);
  await addReaction(db, 'boundary', 'gg', boundaryId, now - 2 * DAY);
  await addReaction(db, 'recent', 'gg', randomUUID(), now - 10_000);
  await pruneReactionEvents(db, now);
  assert.equal((await getCounts(db)).gg, 3);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM reaction_events').get()?.count, 2);
  assert.equal((await addReaction(db, 'boundary', 'gg', boundaryId, now)).receipt?.duplicate, true);
  assert.equal((await addReaction(db, 'recent', 'gg', randomUUID(), now)).retryAfter, 50);
  assert.equal((await addReaction(db, 'expired', 'gg', expiredId, now)).receipt?.duplicate, false);
  assert.equal((await getCounts(db)).gg, 4);
});

test('independent SQLite connections racing duplicate and distinct requests enforce one increment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'about-reactions-'));
  const file = join(directory, 'test.sqlite');
  const setup = new DatabaseSync(file);
  setup.exec('PRAGMA journal_mode=WAL;');
  setup.exec(await readFile(new URL('../migrations/0001_workbench_reactions.sql', import.meta.url), 'utf8'));
  setup.close();
  const sharedId = randomUUID();
  try {
    await Promise.all(
      Array.from(
        { length: 12 },
        (_, index) =>
          new Promise<void>((resolve, reject) => {
            const worker = new Worker(
              `
        const { workerData, parentPort } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(workerData.file);
        db.exec('PRAGMA busy_timeout=10000');
        for (const values of workerData.bindings) db.prepare(workerData.sql).run(...values);
        db.close(); parentPort.postMessage('done');
      `,
              {
                eval: true,
                workerData: {
                  file,
                  sql: INSERT_REACTION,
                  bindings: [
                    insertBindings('same-visitor', index % 2 === 0 ? sharedId : randomUUID(), 'gg', now),
                    insertBindings(`independent-${index}`, randomUUID(), 'shower', now),
                  ],
                },
              }
            );
            worker.once('message', () => resolve());
            worker.once('error', reject);
            worker.once('exit', (code) => {
              if (code) reject(new Error('SQLite worker failed'));
            });
          })
      )
    );
    const final = new DatabaseSync(file);
    assert.equal(final.prepare("SELECT total FROM reaction_totals WHERE kind='gg'").get()?.total, 1);
    assert.equal(final.prepare("SELECT total FROM reaction_totals WHERE kind='shower'").get()?.total, 12);
    assert.equal(
      final.prepare("SELECT COUNT(*) AS count FROM reaction_events WHERE visitor='same-visitor'").get()?.count,
      1
    );
    final.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
