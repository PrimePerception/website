import { AboutApiError, getAboutApiBase, requestAboutApi } from './api';
import {
  historySegments,
  mergeReactionCooldowns,
  RANGE_MILLISECONDS,
  readReactionCounts,
  readReactionReceipt,
  readWorkbenchHistory,
  readWorkbenchStatus,
} from './activity-data';
import { ActivityVisitorSession, reactionRetryAction } from './activity-session';
import {
  HISTORY_RANGES,
  REACTION_KINDS,
  type HistoryRange,
  type ReactionCounts,
  type ReactionKind,
  type ReactionSession,
  type WorkbenchHistory,
  type WorkbenchStatus,
} from './contracts';

const LABELS: Record<ReactionKind, string> = {
  gg: 'GG',
  'touch-grass': 'Touch Grass (Go For A Hike)',
  shower: 'Shower',
  league: 'Play League',
};
const RANGE_LABELS: Record<HistoryRange, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
const BUCKET_MILLISECONDS: Record<HistoryRange, number> = { '24h': 300_000, '7d': 3_600_000, '30d': 10_800_000 };
const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});
const trackingDate = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'America/Vancouver',
});
const number = new Intl.NumberFormat();
const unavailableStatus: WorkbenchStatus = {
  utilizationPercent: null,
  status: 'unavailable',
  stale: false,
  lastUpdatedAt: null,
  trackingStartedAt: null,
};

function text(element: Element | null, value: string) {
  if (element && element.textContent !== value) element.textContent = value;
}

class WorkbenchElement extends HTMLElement {
  #range: HistoryRange = '24h';
  #status: WorkbenchStatus = { ...unavailableStatus };
  #lifecycle: AbortController | null = null;
  #request: AbortController | null = null;
  #timer: number | null = null;
  #staleTimer: number | null = null;

  connectedCallback() {
    if (this.#lifecycle) return;
    this.#lifecycle = new AbortController();
    const { signal } = this.#lifecycle;
    this.addEventListener('click', this.#changeRange, { signal });
    document.addEventListener('visibilitychange', this.#visibilityChanged, { signal });
    if (getAboutApiBase()) {
      this.querySelectorAll<HTMLButtonElement>('[data-history-range]').forEach((button) => {
        button.disabled = false;
      });
      this.#timer = window.setInterval(() => void this.#refresh(), 30_000);
      void this.#refresh();
    }
  }

  disconnectedCallback() {
    this.#lifecycle?.abort();
    this.#lifecycle = null;
    this.#request?.abort();
    this.#request = null;
    if (this.#timer !== null) window.clearInterval(this.#timer);
    this.#timer = null;
    if (this.#staleTimer !== null) window.clearTimeout(this.#staleTimer);
    this.#staleTimer = null;
  }

  #visibilityChanged = () => {
    if (document.hidden) this.#request?.abort();
    else void this.#refresh();
  };

  #changeRange = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-history-range]');
    const range = button?.dataset.historyRange as HistoryRange | undefined;
    if (!range || !HISTORY_RANGES.includes(range) || range === this.#range || !getAboutApiBase()) return;
    this.#range = range;
    this.querySelectorAll<HTMLButtonElement>('[data-history-range]').forEach((control) => {
      control.setAttribute('aria-pressed', String(control.dataset.historyRange === range));
    });
    this.#clearChart('Loading recorded activity…');
    void this.#refresh();
  };

  async #refresh() {
    if (document.hidden || !getAboutApiBase() || !this.isConnected) return;
    this.#status = readWorkbenchStatus(this.#status);
    this.#renderStatus();
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    const range = this.#range;
    const results = await Promise.allSettled([
      requestAboutApi('/v1/workbench/status', { signal: request.signal }),
      requestAboutApi(`/v1/workbench/history?range=${range}`, { signal: request.signal }),
    ]);
    if (request.signal.aborted || !this.isConnected) return;
    try {
      if (results[0].status !== 'fulfilled') throw new Error('Status unavailable.');
      this.#status = readWorkbenchStatus(results[0].value);
      this.#renderStatus();
    } catch {
      this.#status = {
        ...this.#status,
        status: 'unavailable',
        utilizationPercent: null,
        stale: this.#status.lastUpdatedAt !== null && Date.now() - Date.parse(this.#status.lastUpdatedAt) > 180_000,
      };
      this.#renderStatus();
    }
    try {
      if (results[1].status !== 'fulfilled') throw new Error('History unavailable.');
      const history = readWorkbenchHistory(results[1].value);
      if (history.range !== range) throw new Error('Unexpected history range.');
      this.#renderChart(history);
    } catch {
      this.#clearChart('Recorded activity is temporarily unavailable.');
    }
  }

  #renderStatus() {
    const { utilizationPercent, status, stale, lastUpdatedAt, trackingStartedAt } = this.#status;
    const value = this.querySelector('[data-workbench-value]');
    const display = utilizationPercent === null ? '—' : utilizationPercent.toFixed(1);
    text(value, display);
    if (utilizationPercent !== null && value) {
      const suffix = document.createElement('small');
      suffix.textContent = '%';
      value.append(suffix);
    }
    value?.setAttribute(
      'aria-label',
      utilizationPercent === null ? 'GPU utilization unavailable' : `${display} percent GPU utilization`
    );
    text(this.querySelector('[data-workbench-state]'), status[0].toUpperCase() + status.slice(1));
    const badge = this.querySelector<HTMLElement>('[data-workbench-badge]');
    if (badge) badge.dataset.state = status;
    const meter = this.querySelector<HTMLElement>('[data-workbench-meter]');
    if (utilizationPercent === null) {
      meter?.setAttribute('role', 'img');
      meter?.setAttribute('aria-label', 'Aggregate GPU utilization unavailable');
      for (const attribute of ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext']) {
        meter?.removeAttribute(attribute);
      }
    } else {
      meter?.setAttribute('role', 'progressbar');
      meter?.setAttribute('aria-label', 'Aggregate GPU utilization');
      meter?.setAttribute('aria-valuemin', '0');
      meter?.setAttribute('aria-valuemax', '100');
      meter?.setAttribute('aria-valuenow', display);
      meter?.setAttribute('aria-valuetext', `${display} percent`);
    }
    const fill = meter?.querySelector<HTMLElement>('span');
    if (fill) fill.style.width = `${utilizationPercent ?? 0}%`;
    this.#renderTracking(trackingStartedAt);
    if (this.#staleTimer !== null) window.clearTimeout(this.#staleTimer);
    this.#staleTimer = null;
    if (lastUpdatedAt && !stale) {
      this.#staleTimer = window.setTimeout(
        () => {
          this.#status = { ...this.#status, stale: true, status: 'unavailable', utilizationPercent: null };
          this.#renderStatus();
        },
        Math.max(1, Date.parse(lastUpdatedAt) + 180_001 - Date.now())
      );
    }
  }

  #renderTracking(start: string | null) {
    text(
      this.querySelector('[data-tracking-start]'),
      start ? `Tracking began ${trackingDate.format(new Date(start))}.` : 'Tracking has not started.'
    );
  }

  #clearChart(message: string) {
    this.querySelector('[data-history-lines]')?.replaceChildren();
    const empty = this.querySelector<HTMLElement>('[data-history-empty]');
    if (empty) {
      empty.hidden = false;
      text(empty, message);
    }
    text(this.querySelector('#workbench-chart-title'), `GPU utilization over the last ${RANGE_LABELS[this.#range]}`);
    text(this.querySelector('#workbench-chart-description'), `${message} Missing readings appear as gaps.`);
    text(this.querySelector('[data-history-start]'), `${RANGE_LABELS[this.#range]} ago`);
    text(this.querySelector('[data-history-end]'), 'Now');
    const cell = document.createElement('td');
    cell.colSpan = 2;
    cell.textContent = message;
    const row = document.createElement('tr');
    row.append(cell);
    this.querySelector('[data-history-table]')?.replaceChildren(row);
  }

  #renderChart(history: WorkbenchHistory) {
    const { points, range, trackingStartedAt } = history;
    const now = Date.now();
    const start = Math.max(now - RANGE_MILLISECONDS[range], trackingStartedAt ? Date.parse(trackingStartedAt) : 0);
    const visible = points.filter(
      (point) => Date.parse(point.timestamp) <= now && Date.parse(point.timestamp) >= start
    );
    const valid = visible.filter((point) => point.utilizationPercent !== null);
    this.#clearChart(valid.length ? '' : 'No complete readings in this window.');
    const empty = this.querySelector<HTMLElement>('[data-history-empty]');
    if (empty) empty.hidden = valid.length > 0;
    const layer = this.querySelector('[data-history-lines]');
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const coordinates = (point: (typeof points)[number]) => [
      38 + ((Date.parse(point.timestamp) - start) / Math.max(now - start, 1)) * 472,
      132 - (point.utilizationPercent! / 100) * 120,
    ];
    for (const segment of historySegments(visible, BUCKET_MILLISECONDS[range] * 1.05)) {
      if (segment.length === 1) {
        const [x, y] = coordinates(segment[0]);
        const circle = document.createElementNS(svgNamespace, 'circle');
        circle.setAttribute('cx', x.toFixed(2));
        circle.setAttribute('cy', y.toFixed(2));
        circle.setAttribute('r', '2.5');
        layer?.append(circle);
      } else {
        const path = document.createElementNS(svgNamespace, 'path');
        path.setAttribute(
          'd',
          segment
            .map((point, index) => {
              const [x, y] = coordinates(point);
              return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
            })
            .join(' ')
        );
        layer?.append(path);
      }
    }
    const summary = valid.length
      ? 'Aggregate GPU utilization. Missing readings appear as gaps.'
      : 'No complete readings in this window. Missing readings appear as gaps.';
    text(this.querySelector('#workbench-chart-description'), summary);
    text(this.querySelector('[data-history-start]'), dateTime.format(new Date(start)));
    if (trackingStartedAt) this.#renderTracking(trackingStartedAt);
    if (visible.length) {
      const rows = visible.map((point) => {
        const row = document.createElement('tr');
        const time = document.createElement('td');
        const value = document.createElement('td');
        time.textContent = dateTime.format(new Date(point.timestamp));
        value.textContent =
          point.utilizationPercent === null ? 'Unavailable' : `${point.utilizationPercent.toFixed(1)}%`;
        row.append(time, value);
        return row;
      });
      this.querySelector('[data-history-table]')?.replaceChildren(...rows);
    }
  }
}

function readStored(key: string): unknown {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing and blocked storage still allow a temporary in-memory session.
  }
}

class EncouragementElement extends HTMLElement {
  #counts: ReactionCounts | null = null;
  #sessions: ActivityVisitorSession | null = null;
  #cooldowns: Partial<Record<ReactionKind, number>> = {};
  #pending: ReactionKind | null = null;
  #lifecycle: AbortController | null = null;
  #pollTimer: number | null = null;
  #cooldownTimer: number | null = null;
  #totalsRequest: AbortController | null = null;

  get #storageKey() {
    return `about-reactions-v1:${getAboutApiBase()}`;
  }

  connectedCallback() {
    if (this.#lifecycle) return;
    this.#lifecycle = new AbortController();
    const { signal } = this.#lifecycle;
    this.#sessions ??= new ActivityVisitorSession({
      read: () => readStored(`${this.#storageKey}:session`),
      write: (session) => writeStored(`${this.#storageKey}:session`, session),
      issue: (requestSignal) =>
        requestAboutApi('/v1/reactions/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          cache: 'no-store',
          signal: requestSignal,
        }),
      exclusive: navigator.locks
        ? async (callback, requestSignal) =>
            await navigator.locks.request(`${this.#storageKey}:session-lock`, { signal: requestSignal }, callback)
        : undefined,
    });
    this.#restoreCooldowns();
    this.addEventListener('click', this.#click, { signal });
    this.addEventListener('animationend', this.#animationEnded, { signal });
    document.addEventListener('visibilitychange', this.#visibilityChanged, { signal });
    window.addEventListener('storage', this.#storageChanged, { signal });
    this.#cooldownTimer = window.setInterval(() => {
      if (!document.hidden) this.#render();
    }, 1_000);
    if (getAboutApiBase()) {
      this.#pollTimer = window.setInterval(() => void this.#refresh(), 30_000);
      void this.#refresh();
    }
  }

  disconnectedCallback() {
    this.#lifecycle?.abort();
    this.#lifecycle = null;
    this.#totalsRequest?.abort();
    this.#totalsRequest = null;
    if (this.#pollTimer !== null) window.clearInterval(this.#pollTimer);
    if (this.#cooldownTimer !== null) window.clearInterval(this.#cooldownTimer);
    this.#pollTimer = this.#cooldownTimer = null;
    this.#pending = null;
  }

  #animationEnded = (event: Event) => (event.target as Element).closest('button')?.classList.remove('is-reacting');
  #storageChanged = (event: StorageEvent) => {
    if (event.key === `${this.#storageKey}:cooldowns`) {
      this.#restoreCooldowns();
      this.#render();
    }
  };
  #visibilityChanged = () => {
    if (document.hidden) this.#totalsRequest?.abort();
    else {
      this.#restoreCooldowns();
      this.#render();
      void this.#refresh();
    }
  };

  async #refresh() {
    if (document.hidden || this.#pending || !getAboutApiBase() || !this.#lifecycle) return;
    this.#totalsRequest?.abort();
    const request = new AbortController();
    this.#totalsRequest = request;
    const lifecycle = this.#lifecycle;
    const abort = () => request.abort();
    lifecycle.signal.addEventListener('abort', abort, { once: true });
    try {
      const counts = readReactionCounts(await requestAboutApi('/v1/reactions', { signal: request.signal }));
      if (request.signal.aborted || !this.isConnected || this.#pending) return;
      for (const kind of REACTION_KINDS) counts[kind] = Math.max(counts[kind], this.#counts?.[kind] ?? 0);
      const firstLoad = this.#counts === null;
      this.#counts = counts;
      this.#render();
      if (firstLoad) this.#announce('');
    } catch {
      if (!request.signal.aborted && this.isConnected && this.#counts === null) {
        this.#announce('Reactions are temporarily unavailable. Please try again later.');
      }
    } finally {
      lifecycle.signal.removeEventListener('abort', abort);
    }
  }

  #restoreCooldowns() {
    this.#cooldowns = mergeReactionCooldowns(this.#cooldowns, readStored(`${this.#storageKey}:cooldowns`));
  }

  #setCooldown(kind: ReactionKind, until: number) {
    this.#restoreCooldowns();
    this.#cooldowns[kind] = Math.max(this.#cooldowns[kind] ?? 0, until);
    writeStored(`${this.#storageKey}:cooldowns`, this.#cooldowns);
  }

  async #getSession(signal: AbortSignal): Promise<ReactionSession> {
    if (!this.#sessions) throw new AboutApiError(0);
    return this.#sessions.get(signal);
  }

  #click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-reaction]');
    const kind = button?.dataset.reaction as ReactionKind | undefined;
    if (!button || !kind || !REACTION_KINDS.includes(kind) || button.disabled) return;
    void this.#react(kind, button);
  };

  async #react(kind: ReactionKind, button: HTMLButtonElement) {
    this.#restoreCooldowns();
    if (this.#pending || !this.#counts || !this.#lifecycle || (this.#cooldowns[kind] ?? 0) > Date.now()) return;
    const signal = this.#lifecycle.signal;
    const requestId = crypto.randomUUID();
    this.#pending = kind;
    this.#render();
    button.classList.remove('is-reacting');
    requestAnimationFrame(() => button.classList.add('is-reacting'));
    this.#announce(`${LABELS[kind]} sent…`);
    try {
      let receipt;
      let attemptedToken: string | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const session = await this.#getSession(signal);
          attemptedToken = session.token;
          receipt = readReactionReceipt(
            await requestAboutApi('/v1/reactions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
              body: JSON.stringify({ kind, requestId }),
              cache: 'no-store',
              signal,
            })
          );
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          const retry = reactionRetryAction(error instanceof AboutApiError ? error.status : null, attempt);
          if (retry === 'renew-session') {
            this.#sessions?.invalidate(attemptedToken);
            continue;
          }
          if (retry === 'retry') {
            // A transport retry always reuses the same logical click ID.
            continue;
          }
          throw error;
        }
      }
      if (!receipt || !receipt.accepted) throw new AboutApiError(0);
      if (signal.aborted) return;
      this.#counts = receipt.counts;
      const midnightUtc = new Date();
      midnightUtc.setUTCHours(24, 0, 0, 0);
      const until = receipt.remainingToday === 0 ? midnightUtc.getTime() : Date.parse(receipt.nextAllowedAt);
      this.#setCooldown(kind, until);
      this.#announce(
        receipt.remainingToday === 0
          ? `${LABELS[kind]} received. You've used today's 20 reactions of this kind. More after midnight UTC.`
          : `${LABELS[kind]} received. Thank you! The button will be ready again after its cooldown.`
      );
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof AboutApiError && error.status === 429) {
        this.#setCooldown(kind, Date.now() + (error.retryAfter ?? 60) * 1_000);
        this.#announce('A little breather. Please wait before sending this reaction again.');
      } else {
        this.#announce('That reaction could not be confirmed. Please try again in a moment.');
      }
    } finally {
      if (!signal.aborted) {
        this.#pending = null;
        this.#render();
      }
    }
  }

  #render() {
    for (const kind of REACTION_KINDS) {
      const button = this.querySelector<HTMLButtonElement>(`[data-reaction="${kind}"]`);
      if (!button) continue;
      const count = this.#counts ? this.#counts[kind] + (this.#pending === kind ? 1 : 0) : null;
      const seconds = Math.max(0, Math.ceil(((this.#cooldowns[kind] ?? 0) - Date.now()) / 1_000));
      text(this.querySelector(`[data-reaction-count="${kind}"]`), count === null ? '—' : number.format(count));
      const wait = seconds > 3_600 ? 'Available after midnight UTC' : seconds ? `Ready in ${seconds}s` : '';
      text(this.querySelector(`[data-reaction-wait="${kind}"]`), wait);
      button.disabled = this.#counts === null || this.#pending !== null || seconds > 0 || !getAboutApiBase();
      button.dataset.cooling = String(seconds > 0);
      button.setAttribute('aria-busy', String(this.#pending === kind));
      button.setAttribute(
        'aria-label',
        `${LABELS[kind]}: ${count === null ? 'count unavailable' : `${number.format(count)} reactions`}${wait ? `. ${wait}` : ''}`
      );
    }
  }

  #announce(message: string) {
    text(this.querySelector('[data-reaction-feedback]'), message);
  }
}

export function registerWorkbench() {
  if (!customElements.get('about-workbench')) customElements.define('about-workbench', WorkbenchElement);
}

export function registerEncouragement() {
  if (!customElements.get('about-encouragement')) customElements.define('about-encouragement', EncouragementElement);
}
