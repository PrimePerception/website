import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTelemetry, collectUtilization } from '../src/runpod';
import { getHistory, getStatus, MINUTE, RETENTION, saveSample } from '../src/workbench';
import { testDatabase } from './database';

const now = Date.parse('2026-10-27T17:30:20Z');
function pod(values: unknown[], count = values.length) {
  return {
    desiredStatus: 'RUNNING',
    gpuCount: count,
    runtime: { gpus: values.map((value) => ({ gpuUtilPercent: value })) },
    latestTelemetry: { state: 'RUNNING', time: new Date(now).toISOString() },
  };
}
const response = (pods: unknown[]) => ({ data: { myself: { pods } } });

test('aggregation weights GPUs equally across pods, rounds one decimal, and accepts true zeros', () => {
  assert.equal(aggregateTelemetry(response([pod([10]), pod([80, 90])]), now), 60);
  assert.equal(aggregateTelemetry(response([pod([1, 2, 2])]), now), 1.7);
  assert.equal(aggregateTelemetry(response([pod([0, 0])]), now), 0);
  assert.equal(aggregateTelemetry(response([]), now), 0);
  assert.equal(aggregateTelemetry(response([{ desiredStatus: 'EXITED' }]), now), 0);
});

test('missing, partial, stale, starting, out-of-range and nonnumeric telemetry fail closed', () => {
  const incomplete = [
    null,
    {},
    { data: { myself: { pods: null } } },
    { ...response([pod([40])]), errors: [{ message: 'PRIVATE' }] },
    response([pod([40], 2)]),
    response([pod([null])]),
    response([pod(['0'])]),
    response([pod([101])]),
    response([pod([NaN])]),
    response([{ ...pod([40]), runtime: null }]),
    response([{ ...pod([40]), latestTelemetry: { state: 'RUNNING', time: new Date(now - 180_001).toISOString() } }]),
    response([{ ...pod([40]), latestTelemetry: { state: 'STARTING', time: new Date(now).toISOString() } }]),
  ];
  for (const value of incomplete) assert.equal(aggregateTelemetry(value, now), null);
});

test('stopped targets cannot hide contradictory or ambiguous running telemetry', () => {
  const stopped = { desiredStatus: 'EXITED', gpuCount: 1, runtime: null };
  assert.equal(aggregateTelemetry(response([stopped]), now), 0);
  assert.equal(aggregateTelemetry(response([{ ...stopped, latestTelemetry: null }]), now), 0);
  assert.equal(
    aggregateTelemetry(
      response([{ ...stopped, latestTelemetry: { state: 'EXITED', time: new Date(now).toISOString() } }]),
      now
    ),
    0
  );
  const ambiguous = [
    { ...pod([90]), desiredStatus: 'EXITED' },
    { ...stopped, latestTelemetry: { state: 'RUNNING', time: new Date(now).toISOString() } },
    { ...stopped, runtime: { gpus: [{ gpuUtilPercent: 0 }] } },
    { ...stopped, runtime: {} },
    { ...stopped, latestTelemetry: { state: 'STOPPING', time: new Date(now).toISOString() } },
    { ...stopped, latestTelemetry: { state: 'EXITED' } },
    { ...stopped, latestTelemetry: { state: 'EXITED', time: new Date(now - 180_001).toISOString() } },
  ];
  for (const value of ambiguous) {
    assert.equal(aggregateTelemetry(response([value]), now), null);
    assert.equal(aggregateTelemetry(response([pod([40]), value]), now), null);
  }
});

test('outages and authentication failures return only null, never provider messages', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('PRIVATE_PROVIDER_ERROR', { status: 401 });
    assert.equal(await collectUtilization('private-key', now), null);
    globalThis.fetch = async () => {
      throw new Error('PRIVATE_HOST_AND_KEY');
    };
    assert.equal(await collectUtilization('private-key', now), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('tracking starts on first valid production sample and survives outages and pruning', async () => {
  const { db } = testDatabase();
  await saveSample(db, null, now, true);
  assert.equal((await getStatus(db, now)).trackingStartedAt, null);
  await saveSample(db, 22.5, now + MINUTE, true);
  const start = new Date(now + MINUTE).toISOString();
  assert.equal((await getStatus(db, now + MINUTE)).trackingStartedAt, start);
  await saveSample(db, null, now + 2 * MINUTE, true);
  const failed = await getStatus(db, now + 2 * MINUTE);
  assert.equal(failed.utilizationPercent, null);
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.lastUpdatedAt, start);
  assert.equal((await getStatus(db, now + 4 * MINUTE)).stale, true);
  await saveSample(db, 0, now + RETENTION + 20 * MINUTE, true);
  const status = await getStatus(db, now + RETENTION + 20 * MINUTE);
  assert.equal(status.status, 'idle');
  assert.equal(status.utilizationPercent, 0);
  assert.equal(status.trackingStartedAt, start);
  assert.deepEqual(Object.keys(status).sort(), [
    'lastUpdatedAt',
    'stale',
    'status',
    'trackingStartedAt',
    'utilizationPercent',
  ]);
});

test('out-of-order and tied samples cannot replace newer same-minute measurements or regress metadata', async () => {
  const { db, sqlite } = testDatabase();
  const minute = Math.floor(now / MINUTE) * MINUTE;
  await saveSample(db, 90, minute + 40_000, true);
  const activation = new Date(minute + 40_000).toISOString();
  await saveSample(db, null, minute + 10_000, true);
  assert.equal((await getStatus(db, minute + 45_000)).utilizationPercent, 90);
  await saveSample(db, null, minute + 50_000, true);
  await saveSample(db, 95, minute + 20_000, true);
  await saveSample(db, 99, minute + 50_000, true);
  const unavailable = await getStatus(db, minute + 55_000);
  assert.equal(unavailable.utilizationPercent, null);
  assert.equal(unavailable.lastUpdatedAt, activation);
  assert.equal(unavailable.trackingStartedAt, activation);
  assert.equal(sqlite.prepare('SELECT last_attempt_at FROM workbench_meta').get()?.last_attempt_at, minute + 50_000);
  await saveSample(db, 0, minute + MINUTE + 5_000, true);
  await saveSample(db, 77, minute + 55_000, true);
  const latest = await getStatus(db, minute + MINUTE + 10_000);
  assert.equal(latest.utilizationPercent, 0);
  assert.equal(latest.lastUpdatedAt, new Date(minute + MINUTE + 5_000).toISOString());
  await saveSample(db, 30, minute + RETENTION + 2 * MINUTE, true);
  await saveSample(db, 88, minute - MINUTE, true);
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS count FROM workbench_samples WHERE minute < ?').get(minute + 2 * MINUTE)?.count,
    0
  );
});

test('nonproduction samples do not activate tracking; charts retain gaps and stay bounded', async () => {
  const { db, sqlite } = testDatabase();
  await saveSample(db, 50, now, false);
  assert.equal((await getStatus(db, now)).trackingStartedAt, null);
  const start = Math.floor(now / (5 * MINUTE)) * 5 * MINUTE;
  for (let i = 0; i < 11; i++) await saveSample(db, i === 6 ? null : 20, start + i * MINUTE, true);
  const history = await getHistory(db, '24h', start + 10 * MINUTE);
  assert.deepEqual(
    history.points.map((point) => point.utilizationPercent),
    [20, null, 20]
  );
  for (const range of ['24h', '7d', '30d'] as const)
    assert.ok((await getHistory(db, range, start + RETENTION)).points.length <= 290);
  await saveSample(db, 20, start + RETENTION + MINUTE, true);
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS count FROM workbench_samples WHERE minute < ?').get(start + MINUTE)?.count,
    0
  );
});
