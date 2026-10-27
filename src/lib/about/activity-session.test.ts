import assert from 'node:assert/strict';
import test from 'node:test';
import { ActivityVisitorSession, reactionRetryAction } from './activity-session';
import type { ReactionSession } from './contracts';

const now = Date.parse('2026-10-27T18:00:00Z');
const session = (name: string, expires = now + 86_400_000): ReactionSession => ({
  token: `${name}-signed-anonymous-token-example`,
  expiresAt: new Date(expires).toISOString(),
});

test('simultaneous tabs issue one visitor session under the shared browser lock', async () => {
  let stored: ReactionSession | null = null;
  let issued = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const options = {
    read: () => stored,
    write: (value: ReactionSession | null) => (stored = value),
    issue: async () => {
      issued += 1;
      return session(String(issued));
    },
    exclusive: (callback: () => Promise<ReactionSession>) => {
      const result = queue.then(callback);
      queue = result.catch(() => undefined);
      return result;
    },
    now: () => now,
  };
  const tabOne = new ActivityVisitorSession(options);
  const tabTwo = new ActivityVisitorSession(options);
  const signal = new AbortController().signal;
  const [first, second] = await Promise.all([tabOne.get(signal), tabTwo.get(signal)]);
  assert.equal(issued, 1);
  assert.equal(first.token, second.token);
});

test('sessions reuse a newer persisted token and renew an expired one', async () => {
  let stored: ReactionSession | null = session('original');
  let issued = 0;
  const visitor = new ActivityVisitorSession({
    read: () => stored,
    write: (value) => (stored = value),
    issue: async () => {
      issued += 1;
      return session('renewed');
    },
    now: () => now,
  });
  const signal = new AbortController().signal;
  assert.equal((await visitor.get(signal)).token, session('original').token);
  stored = session('another-tab');
  assert.equal((await visitor.get(signal)).token, stored.token);
  visitor.invalidate(session('original').token);
  assert.equal(stored?.token, session('another-tab').token);
  stored = session('expired', now - 1);
  assert.equal((await visitor.get(signal)).token, session('another-tab').token);
  assert.equal(issued, 0);
  visitor.invalidate(session('another-tab').token);
  assert.equal((await visitor.get(signal)).token, session('renewed').token);
  assert.equal(issued, 1);
});

test('aborted navigation does not persist an unconfirmed visitor session', async () => {
  const controller = new AbortController();
  let writes = 0;
  const visitor = new ActivityVisitorSession({
    read: () => null,
    write: () => writes++,
    issue: async () => {
      controller.abort();
      return session('cancelled');
    },
    now: () => now,
  });
  await assert.rejects(visitor.get(controller.signal));
  assert.equal(writes, 0);
});

test('blocked persistent storage retains a temporary in-memory visitor session', async () => {
  let issued = 0;
  const visitor = new ActivityVisitorSession({
    read: () => null,
    write: () => undefined,
    issue: async () => {
      issued += 1;
      return session('temporary');
    },
    now: () => now,
  });
  const signal = new AbortController().signal;
  assert.equal((await visitor.get(signal)).token, (await visitor.get(signal)).token);
  assert.equal(issued, 1);
});

test('failed writes cannot let an expired stored token replace a valid in-memory visitor', async () => {
  const expired = session('expired-stored', now - 1);
  let issued = 0;
  const visitor = new ActivityVisitorSession({
    read: () => expired,
    write: () => undefined,
    issue: async () => {
      issued += 1;
      return session(`memory-${issued}`);
    },
    now: () => now,
  });
  const signal = new AbortController().signal;
  const first = await visitor.get(signal);
  assert.equal((await visitor.get(signal)).token, first.token);
  assert.equal((await visitor.get(signal)).token, first.token);
  assert.equal(issued, 1);
});

test('401 and 403 renew once; transport retries and origin rejection remain bounded', () => {
  assert.equal(reactionRetryAction(401, 0), 'renew-session');
  assert.equal(reactionRetryAction(403, 0), 'renew-session');
  assert.equal(reactionRetryAction(0, 0), 'retry');
  assert.equal(reactionRetryAction(503, 0), 'retry');
  assert.equal(reactionRetryAction(429, 0), 'stop');
  assert.equal(reactionRetryAction(400, 0), 'stop');
  for (const status of [401, 403, 0, 503, null]) assert.equal(reactionRetryAction(status, 1), 'stop');
});
