import {
  HISTORY_RANGES,
  REACTION_KINDS,
  type HistoryPoint,
  type HistoryRange,
  type ReactionCounts,
  type ReactionKind,
  type ReactionReceipt,
  type ReactionSession,
  type WorkbenchHistory,
  type WorkbenchStatus,
} from './contracts';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const instant = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const optionalInstant = (value: unknown): value is string | null => value === null || instant(value);
const percentage = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

export const RANGE_MILLISECONDS: Record<HistoryRange, number> = {
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

export function readWorkbenchStatus(value: unknown, now = Date.now()): WorkbenchStatus {
  if (
    !record(value) ||
    !['active', 'idle', 'unavailable'].includes(String(value.status)) ||
    typeof value.stale !== 'boolean' ||
    !optionalInstant(value.lastUpdatedAt) ||
    !optionalInstant(value.trackingStartedAt) ||
    !(value.utilizationPercent === null || percentage(value.utilizationPercent))
  ) {
    throw new Error('Invalid public status.');
  }
  const status = value as unknown as WorkbenchStatus;
  const stale = status.stale || (status.lastUpdatedAt !== null && now - Date.parse(status.lastUpdatedAt) > 180_000);
  const unavailable =
    stale ||
    status.status === 'unavailable' ||
    status.utilizationPercent === null ||
    status.lastUpdatedAt === null ||
    Date.parse(status.lastUpdatedAt) > now + 60_000;
  return {
    utilizationPercent: unavailable ? null : status.utilizationPercent,
    status: unavailable ? 'unavailable' : status.utilizationPercent! >= 5 ? 'active' : 'idle',
    stale,
    lastUpdatedAt: status.lastUpdatedAt,
    trackingStartedAt: status.trackingStartedAt,
  };
}

export function readWorkbenchHistory(value: unknown): WorkbenchHistory {
  if (
    !record(value) ||
    !HISTORY_RANGES.includes(value.range as HistoryRange) ||
    !optionalInstant(value.trackingStartedAt) ||
    !Array.isArray(value.points) ||
    value.points.length > 1_000 ||
    (value.trackingStartedAt === null && value.points.length > 0)
  ) {
    throw new Error('Invalid public history.');
  }
  let previous = -Infinity;
  const points: HistoryPoint[] = value.points.map((point: unknown) => {
    if (
      !record(point) ||
      !instant(point.timestamp) ||
      !(point.utilizationPercent === null || percentage(point.utilizationPercent)) ||
      Date.parse(point.timestamp) <= previous ||
      (value.trackingStartedAt !== null && Date.parse(point.timestamp) < Date.parse(value.trackingStartedAt as string))
    ) {
      throw new Error('Invalid public history point.');
    }
    previous = Date.parse(point.timestamp);
    return { timestamp: point.timestamp, utilizationPercent: point.utilizationPercent };
  });
  return { range: value.range as HistoryRange, points, trackingStartedAt: value.trackingStartedAt };
}

/** Null samples and skipped buckets always split a line into separate segments. */
export function historySegments(points: HistoryPoint[], maximumGap: number): HistoryPoint[][] {
  const segments: HistoryPoint[][] = [];
  let current: HistoryPoint[] = [];
  let previous: number | null = null;
  for (const point of points) {
    const timestamp = Date.parse(point.timestamp);
    if (point.utilizationPercent === null || (previous !== null && timestamp - previous > maximumGap)) {
      if (current.length) segments.push(current);
      current = [];
    }
    if (point.utilizationPercent !== null) current.push(point);
    previous = timestamp;
  }
  if (current.length) segments.push(current);
  return segments;
}

export function readReactionCounts(value: unknown): ReactionCounts {
  if (!record(value) || !record(value.counts)) throw new Error('Invalid public totals.');
  const counts = {} as ReactionCounts;
  for (const kind of REACTION_KINDS) {
    const count = value.counts[kind];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Invalid public total.');
    }
    counts[kind] = count;
  }
  return counts;
}

export function readReactionSession(value: unknown): ReactionSession {
  if (
    !record(value) ||
    typeof value.token !== 'string' ||
    value.token.length < 20 ||
    value.token.length > 2_048 ||
    !instant(value.expiresAt)
  ) {
    throw new Error('Invalid visitor session.');
  }
  return { token: value.token, expiresAt: value.expiresAt };
}

export function readReactionReceipt(value: unknown): ReactionReceipt {
  const counts = readReactionCounts(value);
  if (
    !record(value) ||
    typeof value.accepted !== 'boolean' ||
    typeof value.duplicate !== 'boolean' ||
    !instant(value.nextAllowedAt) ||
    typeof value.remainingToday !== 'number' ||
    !Number.isInteger(value.remainingToday) ||
    value.remainingToday < 0 ||
    value.remainingToday > 20
  ) {
    throw new Error('Invalid public receipt.');
  }
  return {
    counts,
    accepted: value.accepted,
    duplicate: value.duplicate,
    nextAllowedAt: value.nextAllowedAt,
    remainingToday: value.remainingToday,
  };
}

/** Locally cached eligibility is only a convenience; the database remains authoritative. */
export function mergeReactionCooldowns(
  local: Partial<Record<ReactionKind, number>>,
  stored: unknown,
  now = Date.now()
): Partial<Record<ReactionKind, number>> {
  const result: Partial<Record<ReactionKind, number>> = {};
  for (const kind of REACTION_KINDS) {
    const candidates = [local[kind], record(stored) ? stored[kind] : null];
    for (const until of candidates) {
      if (typeof until === 'number' && until > now && until < now + 2 * 86_400_000) {
        result[kind] = Math.max(result[kind] ?? 0, until);
      }
    }
  }
  return result;
}
