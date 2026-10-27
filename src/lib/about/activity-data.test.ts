import assert from 'node:assert/strict';
import test from 'node:test';
import {
  historySegments,
  mergeReactionCooldowns,
  readReactionCounts,
  readReactionReceipt,
  readWorkbenchHistory,
  readWorkbenchStatus,
} from './activity-data';
import type { HistoryPoint, WorkbenchStatus } from './contracts';

const now = Date.parse('2026-10-27T18:00:00Z');
const status: WorkbenchStatus = {
  status: 'idle',
  stale: false,
  utilizationPercent: 0,
  lastUpdatedAt: new Date(now).toISOString(),
  trackingStartedAt: new Date(now - 3_600_000).toISOString(),
};

test('real zero stays Idle, and the five-percent threshold determines Active', () => {
  assert.equal(readWorkbenchStatus(status, now).utilizationPercent, 0);
  assert.equal(readWorkbenchStatus(status, now).status, 'idle');
  assert.equal(readWorkbenchStatus({ ...status, utilizationPercent: 4.9 }, now).status, 'idle');
  assert.equal(readWorkbenchStatus({ ...status, utilizationPercent: 5 }, now).status, 'active');
});

test('cross-tab cooldown updates merge without dropping another reaction or shortening a wait', () => {
  const result = mergeReactionCooldowns(
    { gg: now + 60_000, shower: now - 1 },
    { gg: now + 30_000, 'touch-grass': now + 60_000, shower: 'invalid', league: now + 3 * 86_400_000 },
    now
  );
  assert.deepEqual(result, { gg: now + 60_000, 'touch-grass': now + 60_000 });
});

test('missing, explicitly unavailable, future, and stale telemetry never become zero', () => {
  for (const update of [
    { utilizationPercent: null },
    { status: 'unavailable' },
    { stale: true },
    { lastUpdatedAt: null },
    { lastUpdatedAt: new Date(now - 180_001).toISOString() },
    { lastUpdatedAt: new Date(now + 60_001).toISOString() },
  ]) {
    const result = readWorkbenchStatus({ ...status, ...update }, now);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.utilizationPercent, null);
  }
  assert.throws(() => readWorkbenchStatus({ ...status, utilizationPercent: Number.NaN }, now));
  assert.throws(() => readWorkbenchStatus({ ...status, utilizationPercent: 101 }, now));
});

test('null intervals and omitted intervals split the chart; valid zero is drawn', () => {
  const point = (minutes: number, value: number | null): HistoryPoint => ({
    timestamp: new Date(now + minutes * 60_000).toISOString(),
    utilizationPercent: value,
  });
  const points = [point(0, 0), point(5, 40), point(10, null), point(15, 50), point(25, 60), point(30, 70)];
  assert.deepEqual(
    historySegments(points, 5 * 60_000).map((segment) => segment.map((entry) => entry.utilizationPercent)),
    [[0, 40], [50], [60, 70]]
  );
});

test('history rejects data before activation, unordered points, and oversized payloads', () => {
  const history = {
    range: '24h',
    trackingStartedAt: status.trackingStartedAt,
    points: [{ timestamp: status.lastUpdatedAt, utilizationPercent: 0 }],
  };
  assert.equal(readWorkbenchHistory(history).points[0].utilizationPercent, 0);
  assert.throws(() => readWorkbenchHistory({ ...history, trackingStartedAt: null }));
  assert.throws(() => readWorkbenchHistory({ ...history, trackingStartedAt: new Date(now + 1).toISOString() }));
  assert.throws(() => readWorkbenchHistory({ ...history, points: [...history.points, ...history.points] }));
  assert.throws(() => readWorkbenchHistory({ ...history, points: Array(1_001).fill(history.points[0]) }));
});

test('public counters and receipts must have complete, bounded values', () => {
  const counts = { gg: 12, 'touch-grass': 2, shower: 0, league: 3 };
  assert.deepEqual(readReactionCounts({ counts }), counts);
  assert.throws(() => readReactionCounts({ counts: { gg: 12 } }));
  assert.throws(() => readReactionCounts({ counts: { ...counts, gg: -1 } }));
  assert.throws(() => readReactionCounts({ counts: { ...counts, league: Number.MAX_SAFE_INTEGER + 1 } }));
  const receipt = {
    counts,
    accepted: true,
    duplicate: true,
    nextAllowedAt: new Date(now + 60_000).toISOString(),
    remainingToday: 19,
  };
  assert.equal(readReactionReceipt(receipt).duplicate, true);
  assert.throws(() => readReactionReceipt({ ...receipt, remainingToday: 21 }));
  assert.throws(() => readReactionReceipt({ ...receipt, nextAllowedAt: 'tomorrow' }));
});
