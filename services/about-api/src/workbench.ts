import type { HistoryRange, WorkbenchHistory, WorkbenchStatus } from '../../../src/lib/about/contracts';
import { TELEMETRY_MAX_AGE } from './runpod';

export const MINUTE = 60_000;
export const RETENTION = 30 * 24 * 60 * MINUTE;
const RANGES: Record<HistoryRange, { duration: number; bucket: number }> = {
  '24h': { duration: 24 * 60 * MINUTE, bucket: 5 * MINUTE },
  '7d': { duration: 7 * 24 * 60 * MINUTE, bucket: 60 * MINUTE },
  '30d': { duration: RETENTION, bucket: 3 * 60 * MINUTE },
};
const iso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString());

export async function saveSample(
  db: D1Database,
  percent: number | null,
  now: number,
  production: boolean
): Promise<void> {
  const minute = Math.floor(now / MINUTE) * MINUTE;
  await db.batch([
    db
      .prepare(
        `INSERT INTO workbench_samples(minute, utilization_percent, collected_at) VALUES(?, ?, ?)
        ON CONFLICT(minute) DO UPDATE SET utilization_percent = excluded.utilization_percent,
          collected_at = excluded.collected_at
        WHERE excluded.collected_at > workbench_samples.collected_at`
      )
      .bind(minute, percent, now),
    db
      .prepare(
        `UPDATE workbench_meta SET
        tracking_started_at = CASE WHEN ? AND ? IS NOT NULL THEN COALESCE(tracking_started_at, ?) ELSE tracking_started_at END,
        last_success_at = CASE WHEN ? IS NOT NULL THEN MAX(COALESCE(last_success_at, 0), ?) ELSE last_success_at END,
        last_attempt_at = MAX(COALESCE(last_attempt_at, 0), ?) WHERE singleton = 1
        AND EXISTS(SELECT 1 FROM workbench_samples
          WHERE minute = ? AND collected_at = ? AND utilization_percent IS ?)`
      )
      .bind(production ? 1 : 0, percent, now, percent, now, now, minute, now, percent),
    db.prepare(`DELETE FROM workbench_samples WHERE minute <
      (SELECT CAST(last_attempt_at / ${MINUTE} AS INTEGER) * ${MINUTE} - ${RETENTION}
        FROM workbench_meta WHERE singleton = 1)`),
  ]);
}

export async function getStatus(db: D1Database, now = Date.now()): Promise<WorkbenchStatus> {
  const meta = await db
    .prepare(
      `SELECT tracking_started_at, last_success_at, last_attempt_at,
      (SELECT utilization_percent FROM workbench_samples ORDER BY minute DESC LIMIT 1) AS utilization_percent
      FROM workbench_meta WHERE singleton = 1`
    )
    .first<{
      tracking_started_at: number | null;
      last_success_at: number | null;
      last_attempt_at: number | null;
      utilization_percent: number | null;
    }>();
  const stale = !meta?.last_success_at || now - meta.last_success_at >= TELEMETRY_MAX_AGE;
  const percent = stale ? null : (meta?.utilization_percent ?? null);
  return {
    utilizationPercent: percent,
    status: percent === null ? 'unavailable' : percent >= 5 ? 'active' : 'idle',
    stale,
    lastUpdatedAt: iso(meta?.last_success_at ?? null),
    trackingStartedAt: iso(meta?.tracking_started_at ?? null),
  };
}

export async function getHistory(db: D1Database, range: HistoryRange, now = Date.now()): Promise<WorkbenchHistory> {
  const meta = await db.prepare('SELECT tracking_started_at FROM workbench_meta WHERE singleton = 1').first<{
    tracking_started_at: number | null;
  }>();
  const start = meta?.tracking_started_at ?? null;
  if (start === null) return { range, points: [], trackingStartedAt: null };
  const { duration, bucket } = RANGES[range];
  const first = Math.floor(Math.max(now - duration, start) / MINUTE) * MINUTE;
  const currentMinute = Math.floor(now / MINUTE) * MINUTE;
  const rows = await db
    .prepare(
      `SELECT CAST(minute / ? AS INTEGER) * ? AS bucket, COUNT(*) AS samples,
      COUNT(utilization_percent) AS valid, AVG(utilization_percent) AS average
      FROM workbench_samples WHERE minute >= ? AND minute <= ? GROUP BY bucket ORDER BY bucket`
    )
    .bind(bucket, bucket, first, currentMinute)
    .all<{ bucket: number; samples: number; valid: number; average: number | null }>();
  const byBucket = new Map(rows.results.map((row) => [row.bucket, row]));
  const points: WorkbenchHistory['points'] = [];
  for (let at = Math.floor(first / bucket) * bucket; at <= currentMinute; at += bucket) {
    const row = byBucket.get(at);
    const expected = (Math.min(at + bucket - MINUTE, currentMinute) - Math.max(at, first)) / MINUTE + 1;
    const complete = row && row.samples === expected && row.valid === expected && row.average !== null;
    points.push({
      timestamp: new Date(Math.max(at, first, start)).toISOString(),
      utilizationPercent: complete ? Math.round(row.average! * 10) / 10 : null,
    });
  }
  return { range, points, trackingStartedAt: new Date(start).toISOString() };
}
