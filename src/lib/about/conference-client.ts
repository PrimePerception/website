import { getAboutApiBase, requestAboutApi } from './api';
import type { ConferenceDeadline } from './contracts';
import {
  ESTIMATE_LABEL,
  conferenceCountdown,
  formatEstimatedWindow,
  formatPublishedDeadline,
  isConferenceFeed,
  isConferenceDeadline,
  registrationIsClosed,
  primaryConferenceDeadline,
  relativeConferenceLabel,
  sortConferences,
} from './conferences';

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function sourceLink(record: ConferenceDeadline, previous = false): HTMLAnchorElement {
  const text = previous ? 'Previous dates' : record.kind === 'confirmed' ? 'Official CFP' : 'Conference page';
  const link = element('a', undefined, `${text} ↗`);
  link.href = previous ? record.estimateSourceUrl! : record.sourceUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute(
    'aria-label',
    `${record.name} ${previous ? 'previous official submission dates' : `${record.year} ${text.toLowerCase()}`} (opens in new tab)`
  );
  return link;
}

function conferenceRow(record: ConferenceDeadline, now: number): HTMLLIElement {
  const row = element('li', 'conference-row');
  const identity = element('div', 'conference-identity');
  const heading = element('h3', undefined, `${record.name} `);
  heading.append(element('span', undefined, String(record.year)));
  identity.append(heading, element('p', 'conference-relative', relativeConferenceLabel(record, now)));
  const detail = element('div', 'conference-detail');
  const primary = primaryConferenceDeadline(record);
  if (primary) detail.append(element('p', 'conference-date-label', primary.label));
  const date = element('p', 'conference-date');
  if (primary) {
    const time = element('time', undefined, formatPublishedDeadline(primary.deadline));
    time.dateTime = primary.deadline.at;
    date.append(time);
  } else
    date.textContent = record.estimatedWindow ? formatEstimatedWindow(record.estimatedWindow) : 'Awaiting announcement';
  detail.append(date);
  if (primary) {
    const timing = element('p', 'conference-timing');
    timing.append(element('span', 'conference-badge', 'Confirmed'), document.createTextNode(' '));
    timing.append(
      registrationIsClosed(record, now)
        ? element('strong', 'conference-closed', 'Registration closed')
        : document.createTextNode(conferenceCountdown(record, now))
    );
    detail.append(timing);
  } else detail.append(element('p', 'conference-estimate', ESTIMATE_LABEL));
  const sources = element('div', 'conference-sources');
  sources.append(sourceLink(record));
  if (record.estimateSourceUrl) sources.append(sourceLink(record, true));
  row.append(identity, detail, sources);
  return row;
}

/** Connected/disconnected lifecycle also works with Astro's page transitions. */
export class ConferenceDeadlinesElement extends HTMLElement {
  private records: ConferenceDeadline[] = [];
  private interval?: number;
  private controller?: AbortController;
  private lastFetch = 0;

  connectedCallback() {
    try {
      const seed: unknown = JSON.parse(this.dataset.records ?? '[]');
      if (Array.isArray(seed) && seed.length === 7 && seed.every(isConferenceDeadline)) this.records = seed;
    } catch {
      /* The static, reviewed markup remains usable. */
    }
    this.render();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.interval = window.setInterval(this.tick, 60_000);
    void this.refresh();
  }

  disconnectedCallback() {
    window.clearInterval(this.interval);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.controller?.abort();
  }

  private onVisibility = () => {
    if (!document.hidden) this.tick();
  };
  private tick = () => {
    if (document.hidden) return;
    this.render();
    if (Date.now() - this.lastFetch >= 3_600_000) void this.refresh();
  };

  private render() {
    if (!this.records.length) return;
    const list = this.querySelector('[data-conference-list]');
    if (!list) return;
    const now = Date.now();
    const focusedSource =
      document.activeElement instanceof HTMLAnchorElement && list.contains(document.activeElement)
        ? document.activeElement.href
        : null;
    list.replaceChildren(...sortConferences(this.records, now).map((record) => conferenceRow(record, now)));
    if (focusedSource)
      [...list.querySelectorAll('a')].find((link) => link.href === focusedSource)?.focus({ preventScroll: true });
  }

  private async refresh() {
    if (document.hidden || !getAboutApiBase() || this.controller) return;
    this.lastFetch = Date.now();
    this.controller = new AbortController();
    try {
      const feed = await requestAboutApi('/v1/conferences', { signal: this.controller.signal });
      if (!isConferenceFeed(feed) || !this.isConnected) return;
      this.records = feed.conferences;
      this.render();
    } catch {
      // Keep the last reviewed records if the public service is unavailable.
    } finally {
      this.controller = undefined;
    }
  }
}
