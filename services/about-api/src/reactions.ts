import {
  REACTION_KINDS,
  type ReactionKind,
  type ReactionCounts,
  type ReactionReceipt,
} from '../../../src/lib/about/contracts';

export const DAY = 86_400_000;
export const COOLDOWN = 60_000;
export const DAILY_CAP = 20;
export const IDEMPOTENCY_RETENTION = 2 * DAY;

/** Cleanup is independent of provider/conference success and never changes permanent totals. */
export async function pruneReactionEvents(db: D1Database, now = Date.now()): Promise<void> {
  await db
    .prepare('DELETE FROM reaction_events WHERE created_at < ?')
    .bind(now - IDEMPOTENCY_RETENTION)
    .run();
}

// Conditions and trigger execute atomically even when separate Workers race on the same visitor.
export const INSERT_REACTION = `INSERT INTO reaction_events(visitor, request_id, kind, created_at, utc_day)
  SELECT ?, ?, ?, ?, ?
  WHERE NOT EXISTS(SELECT 1 FROM reaction_events WHERE visitor = ? AND request_id = ?)
    AND NOT EXISTS(SELECT 1 FROM reaction_events WHERE visitor = ? AND kind = ? AND created_at > ?)
    AND (SELECT COUNT(*) FROM reaction_events WHERE visitor = ? AND kind = ? AND utc_day = ?) < 20`;

export function insertBindings(
  visitor: string,
  requestId: string,
  kind: ReactionKind,
  now: number
): (string | number)[] {
  const day = Math.floor(now / DAY);
  return [visitor, requestId, kind, now, day, visitor, requestId, visitor, kind, now - COOLDOWN, visitor, kind, day];
}

function toCounts(rows: { kind: string; total: number }[]): ReactionCounts {
  if (
    rows.length !== REACTION_KINDS.length ||
    rows.some(
      (row) => !REACTION_KINDS.includes(row.kind as ReactionKind) || !Number.isSafeInteger(row.total) || row.total < 0
    ) ||
    new Set(rows.map((row) => row.kind)).size !== REACTION_KINDS.length
  ) {
    throw new Error('Shared totals unavailable');
  }
  const counts: ReactionCounts = { gg: 0, 'touch-grass': 0, shower: 0, league: 0 };
  for (const row of rows)
    if (REACTION_KINDS.includes(row.kind as ReactionKind)) counts[row.kind as ReactionKind] = row.total;
  return counts;
}

export async function getCounts(db: D1Database): Promise<ReactionCounts> {
  const result = await db.prepare('SELECT kind, total FROM reaction_totals').all<{ kind: string; total: number }>();
  return toCounts(result.results);
}

export type ReactionResult =
  | { receipt: ReactionReceipt; retryAfter?: never }
  | { receipt?: never; retryAfter: number }
  | { invalid: true; receipt?: never; retryAfter?: never };

export async function addReaction(
  db: D1Database,
  visitor: string,
  kind: ReactionKind,
  requestId: string,
  now = Date.now()
): Promise<ReactionResult> {
  const day = Math.floor(now / DAY);
  const result = await db.batch([
    db.prepare(INSERT_REACTION).bind(...insertBindings(visitor, requestId, kind, now)),
    db.prepare('SELECT kind FROM reaction_events WHERE visitor = ? AND request_id = ?').bind(visitor, requestId),
    db
      .prepare(
        'SELECT MAX(created_at) AS latest, SUM(CASE WHEN utc_day = ? THEN 1 ELSE 0 END) AS used FROM reaction_events WHERE visitor = ? AND kind = ?'
      )
      .bind(day, visitor, kind),
    db.prepare('SELECT kind, total FROM reaction_totals'),
  ]);
  const existing = (result[1].results as { kind: string }[])[0];
  if (existing && existing.kind !== kind) return { invalid: true };
  const limits = (result[2].results as { latest: number | null; used: number }[])[0];
  const used = limits?.used ?? 0;
  const next = used >= DAILY_CAP ? (day + 1) * DAY : (limits?.latest ?? now) + COOLDOWN;
  if (!existing) return { retryAfter: Math.max(1, Math.ceil((next - now) / 1000)) };
  return {
    receipt: {
      accepted: true,
      duplicate: result[0].meta.changes === 0,
      counts: toCounts(result[3].results as { kind: string; total: number }[]),
      nextAllowedAt: new Date(Math.max(now, next)).toISOString(),
      remainingToday: Math.max(0, DAILY_CAP - used),
    },
  };
}
