import { CONFERENCE_INFO, conferenceSourceUrl } from '../../data/conferences';
import {
  CONFERENCE_IDS,
  type ConferenceDeadline,
  type ConferenceFeed,
  type ConferenceId,
  type ConfirmedDeadline,
} from './contracts';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ZONES: Record<string, string> = { AoE: 'Etc/GMT+12', AOE: 'Etc/GMT+12', HST: 'Pacific/Honolulu', UTC: 'UTC' };
export const ESTIMATE_LABEL = 'Estimated — based on previous years.';

export function nextConferenceCycle(id: ConferenceId, year: number): number {
  if (id === 'iccv') return year + (year % 2 === 1 ? 2 : 1);
  if (id === 'eccv') return year + (year % 2 === 0 ? 2 : 1);
  return year + 1;
}

export function estimatedConference(record: ConferenceDeadline, year: number): ConferenceDeadline {
  const info = CONFERENCE_INFO[record.id];
  const submissionYear = year - Number(info.previousYear);
  return {
    ...record,
    year,
    kind: 'estimated',
    mainDeadline: null,
    registrationDeadline: null,
    estimatedWindow: {
      start: `${submissionYear}-${String(info.months[0]).padStart(2, '0')}`,
      end: `${submissionYear}-${String(info.months[1]).padStart(2, '0')}`,
    },
    estimateSourceUrl: record.kind === 'confirmed' ? record.sourceUrl : record.estimateSourceUrl,
    sourceUrl: conferenceSourceUrl(record.id, year),
    needsReview: true,
  };
}

export function windowEnd(window: NonNullable<ConferenceDeadline['estimatedWindow']>): number {
  const [year, month] = window.end.split('-').map(Number);
  return Date.UTC(year, month, 1) - 1;
}

/** Never promote a month estimate into a fabricated day or silently roll an unannounced cycle. */
export function resolveConference(record: ConferenceDeadline, now = Date.now()): ConferenceDeadline {
  let result = record;
  if (record.kind === 'confirmed' && record.mainDeadline && Date.parse(record.mainDeadline.at) <= now) {
    result = estimatedConference(record, nextConferenceCycle(record.id, record.year));
  }
  if (result.estimatedWindow && windowEnd(result.estimatedWindow) < now) return { ...result, needsReview: true };
  return result;
}

export function sortConferences(records: ConferenceDeadline[], now = Date.now()): ConferenceDeadline[] {
  const key = (record: ConferenceDeadline) =>
    record.mainDeadline
      ? nextConferenceActionAt(record, now)!
      : record.estimatedWindow && windowEnd(record.estimatedWindow) >= now
        ? Date.parse(`${record.estimatedWindow.start}-01T00:00:00Z`)
        : Number.MAX_SAFE_INTEGER;
  return records
    .map((record) => resolveConference(record, now))
    .sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name));
}

/** Published registration is the primary deadline; absence never implies an invented abstract deadline. */
export function primaryConferenceDeadline(record: ConferenceDeadline): {
  deadline: ConfirmedDeadline;
  label: string;
  registration: boolean;
} | null {
  if (record.kind !== 'confirmed' || !record.mainDeadline) return null;
  return record.registrationDeadline
    ? { deadline: record.registrationDeadline, label: record.registrationLabel, registration: true }
    : { deadline: record.mainDeadline, label: 'Paper submission', registration: false };
}

/** Once registration closes, an upcoming paper deadline still determines the row's ordering. */
export function nextConferenceActionAt(record: ConferenceDeadline, now = Date.now()): number | null {
  if (!record.mainDeadline) return null;
  if (record.registrationDeadline && Date.parse(record.registrationDeadline.at) > now)
    return Date.parse(record.registrationDeadline.at);
  return Date.parse(record.mainDeadline.at);
}

export function conferenceCountdown(record: ConferenceDeadline, now = Date.now()): string {
  const primary = primaryConferenceDeadline(record);
  if (!primary) return '';
  if (primary.registration && Date.parse(primary.deadline.at) <= now) return 'Registration closed';
  return deadlineCountdown(primary.deadline.at, now);
}

function monthParts(now: number, timeZone = 'UTC'): [number, number] {
  const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', timeZone }).formatToParts(
    new Date(now)
  );
  return [
    Number(parts.find((part) => part.type === 'year')!.value),
    Number(parts.find((part) => part.type === 'month')!.value),
  ];
}

export function relativeConferenceLabel(record: ConferenceDeadline, now = Date.now()): string {
  if (record.estimatedWindow && windowEnd(record.estimatedWindow) < now) return 'Awaiting announcement';
  if (registrationIsClosed(record, now)) return 'Registration closed';
  const primary = primaryConferenceDeadline(record)?.deadline;
  const publishedZone = primary ? (ZONES[primary.timeZone] ?? primary.timeZone) : 'UTC';
  const [year, month] = primary
    ? monthParts(Date.parse(primary.at), publishedZone)
    : record.estimatedWindow
      ? record.estimatedWindow.start.split('-').map(Number)
      : [];
  if (!year || !month) return 'Awaiting announcement';
  const [currentYear, currentMonth] = monthParts(now, publishedZone);
  const difference = (year - currentYear) * 12 + month - currentMonth;
  if (difference <= 0) return 'This month';
  if (difference === 1) return 'Next month';
  return `About ${difference} months away`;
}

export function formatEstimatedWindow(window: NonNullable<ConferenceDeadline['estimatedWindow']>): string {
  const format = (value: string, includeYear = true) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'long',
      ...(includeYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    }).format(new Date(`${value}-01T12:00:00Z`));
  if (window.start === window.end) return format(window.start);
  return `${format(window.start, window.start.slice(0, 4) !== window.end.slice(0, 4))}–${format(window.end)}`;
}

export function formatPublishedDeadline(deadline: ConfirmedDeadline): string {
  const timeZone = ZONES[deadline.timeZone] ?? deadline.timeZone;
  return `${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(deadline.at))} ${deadline.timeZone}`;
}

export function deadlineCountdown(at: string, now = Date.now()): string {
  const remaining = Date.parse(at) - now;
  if (remaining <= 0) return 'Submission closed';
  if (remaining >= 86_400_000) {
    const days = Math.ceil(remaining / 86_400_000);
    return `${days} ${days === 1 ? 'day' : 'days'} remaining`;
  }
  if (remaining >= 3_600_000) {
    const hours = Math.ceil(remaining / 3_600_000);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} remaining`;
  }
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} remaining`;
}

export function registrationIsClosed(record: ConferenceDeadline, now = Date.now()): boolean {
  return Boolean(
    record.registrationDeadline &&
    record.mainDeadline &&
    Date.parse(record.registrationDeadline.at) <= now &&
    Date.parse(record.mainDeadline.at) > now
  );
}

export function isOfficialConferenceUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ['cvpr.thecvf.com', 'icml.cc', 'iccv.thecvf.com', 'neurips.cc', 'aaai.org', 'iclr.cc', 'eccv.ecva.net'].includes(
        url.hostname
      )
    );
  } catch {
    return false;
  }
}

const isInstant = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
function validDeadline(value: unknown): value is ConfirmedDeadline {
  if (!value || typeof value !== 'object') return false;
  const deadline = value as ConfirmedDeadline;
  if (!isInstant(deadline.at) || typeof deadline.timeZone !== 'string' || deadline.timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: ZONES[deadline.timeZone] ?? deadline.timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Validate the public service payload before it becomes DOM content or a source link. */
export function isConferenceDeadline(value: unknown): value is ConferenceDeadline {
  if (!value || typeof value !== 'object') return false;
  const record = value as ConferenceDeadline;
  if (
    !CONFERENCE_IDS.includes(record.id) ||
    record.name !== CONFERENCE_INFO[record.id].name ||
    !Number.isInteger(record.year) ||
    record.year < 2026 ||
    record.year > 2100
  )
    return false;
  if ((record.id === 'iccv' && record.year % 2 !== 1) || (record.id === 'eccv' && record.year % 2 !== 0)) return false;
  if (
    !isOfficialConferenceUrl(record.sourceUrl) ||
    (record.estimateSourceUrl !== null && !isOfficialConferenceUrl(record.estimateSourceUrl))
  )
    return false;
  if (
    !['Abstract registration', 'Paper registration'].includes(record.registrationLabel) ||
    typeof record.needsReview !== 'boolean'
  )
    return false;
  if (
    (record.verifiedAt !== null && !isInstant(record.verifiedAt)) ||
    (record.checkedAt !== null && !isInstant(record.checkedAt))
  )
    return false;
  if (record.registrationDeadline !== null && !validDeadline(record.registrationDeadline)) return false;
  if (record.kind === 'confirmed') return validDeadline(record.mainDeadline) && record.estimatedWindow === null;
  return (
    record.kind === 'estimated' &&
    record.mainDeadline === null &&
    record.registrationDeadline === null &&
    Boolean(
      record.estimatedWindow &&
      MONTH.test(record.estimatedWindow.start) &&
      MONTH.test(record.estimatedWindow.end) &&
      record.estimatedWindow.start <= record.estimatedWindow.end
    )
  );
}

export function isConferenceFeed(value: unknown): value is ConferenceFeed {
  if (!value || typeof value !== 'object') return false;
  const feed = value as ConferenceFeed;
  return (
    isInstant(feed.generatedAt) &&
    Array.isArray(feed.conferences) &&
    feed.conferences.length === 7 &&
    feed.conferences.every(isConferenceDeadline) &&
    new Set(feed.conferences.map((record) => record.id)).size === 7
  );
}
