/** Public-only contracts. Provider payloads and secrets must never enter these types. */
export const REACTION_KINDS = ['gg', 'touch-grass', 'shower', 'league'] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];
export type ReactionCounts = Record<ReactionKind, number>;

export interface WorkbenchStatus {
  utilizationPercent: number | null;
  status: 'active' | 'idle' | 'unavailable';
  stale: boolean;
  lastUpdatedAt: string | null;
  trackingStartedAt: string | null;
}

export const HISTORY_RANGES = ['24h', '7d', '30d'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];
export interface HistoryPoint {
  timestamp: string;
  utilizationPercent: number | null;
}
export interface WorkbenchHistory {
  range: HistoryRange;
  points: HistoryPoint[];
  trackingStartedAt: string | null;
}

export interface ReactionsResponse {
  counts: ReactionCounts;
}
export interface ReactionSession {
  token: string;
  expiresAt: string;
}
export interface ReactionRequest {
  kind: ReactionKind;
  requestId: string;
}
export interface ReactionReceipt extends ReactionsResponse {
  accepted: boolean;
  duplicate: boolean;
  nextAllowedAt: string;
  remainingToday: number;
}
export interface PublicApiError {
  error: 'unavailable' | 'rate_limited' | 'invalid_request' | 'forbidden' | 'not_found';
  retryAfter?: number;
}

export const CONFERENCE_IDS = ['cvpr', 'icml', 'iccv', 'neurips', 'aaai', 'iclr', 'eccv'] as const;
export type ConferenceId = (typeof CONFERENCE_IDS)[number];
export interface ConfirmedDeadline {
  /** ISO instant, normalized to UTC. */
  at: string;
  /** Published zone, e.g. AoE, HST, UTC, or an IANA zone. */
  timeZone: string;
}
export interface ConferenceDeadline {
  id: ConferenceId;
  name: string;
  year: number;
  kind: 'confirmed' | 'estimated';
  mainDeadline: ConfirmedDeadline | null;
  registrationDeadline: ConfirmedDeadline | null;
  registrationLabel: 'Abstract registration' | 'Paper registration';
  /** YYYY-MM only; these are never exact deadline instants. */
  estimatedWindow: { start: string; end: string } | null;
  sourceUrl: string;
  estimateSourceUrl: string | null;
  verifiedAt: string | null;
  checkedAt: string | null;
  needsReview: boolean;
}
export interface ConferenceFeed {
  conferences: ConferenceDeadline[];
  generatedAt: string;
}
