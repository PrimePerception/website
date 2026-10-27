import { CONFERENCE_INFO, CONFERENCE_SEEDS, conferenceSourceUrl } from '../../../src/data/conferences';
import type {
  ConferenceDeadline,
  ConferenceFeed,
  ConferenceId,
  ConfirmedDeadline,
} from '../../../src/lib/about/contracts';
import { isConferenceDeadline, resolveConference, sortConferences } from '../../../src/lib/about/conferences';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

const DAY = 86_400_000;
const MAX_SOURCE_BYTES = 1_000_000;
const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

interface SourcePolicy {
  main: RegExp;
  registration: RegExp;
  scope: RegExp | null;
  prose?: RegExp;
  registrationProse?: RegExp;
}

/** Matching labels are intentionally narrow. New page structures require review and a parser change. */
const SOURCE_POLICIES: Record<ConferenceId, SourcePolicy> = {
  cvpr: {
    main: /^submission deadline\*?$/i,
    registration: /^paper (?:enrollment|registration) deadline\*?$/i,
    scope: null,
  },
  icml: {
    main: /^full paper submission deadline$/i,
    registration: /^abstract submission deadline$/i,
    scope: /^paper submissions$/i,
  },
  iccv: {
    main: /^(?:submission and supplementary materials|paper submission) deadline$/i,
    registration: /^paper registration deadline$/i,
    scope: /^main conference paper submission$/i,
  },
  neurips: {
    main: /^full paper submission deadline$/i,
    registration: /^paper abstract submission deadline$/i,
    scope: /^main conference paper submission$/i,
  },
  aaai: {
    main: /^(?:full paper submission deadline|full papers due|paper submission deadline)$/i,
    registration: /^(?:abstract submission deadline|abstracts due)$/i,
    scope: null,
    prose: /^(?:full papers due|full paper submission deadline|paper submission deadline)\s*(?::|is)\s*(.+)$/i,
    registrationProse: /^(?:abstracts due|abstract submission deadline)\s*(?::|is)\s*(.+)$/i,
  },
  iclr: {
    main: /^full paper submission deadline$/i,
    registration: /^abstract submission deadline$/i,
    scope: null,
    prose: /^(?:the )?full paper submission deadline is\s+(.+)$/i,
    registrationProse:
      /^(?:authors must submit paper abstracts by the abstract submission deadline of|(?:the )?abstract submission deadline is)\s+(.+)$/i,
  },
  eccv: {
    main: /^main conference submission deadline$/i,
    registration: /^paper registration deadline$/i,
    scope: /^paper submissions$/i,
  },
};

type HtmlNode = DefaultTreeAdapterMap['node'];
type HtmlElement = DefaultTreeAdapterMap['element'];
interface Section {
  level: number;
  heading: string;
  text: string[];
}
interface SourceDocument {
  elements: HtmlElement[];
  contexts: WeakMap<HtmlElement, Section[]>;
}

const OMITTED_TAGS = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
  'svg',
]);
const NON_MAIN_SECTION =
  /\b(?:workshops?|tutorials?|supplement(?:ary|al)?|camera[- ]?ready|reviewers?|rebuttals?|notifications?|decisions?|position papers?|datasets?|benchmarks?|competitions?|affinity|demos?|art submissions?|journal|expo|attendees?|payments?|sponsors?)\b/i;
const UNCERTAIN_SECTION =
  /\b(?:tentative|provisional|preliminary|draft|subject to change|(?:estimated|expected|proposed|planned)\s+(?:submission\s+)?(?:dates?|deadlines?)|(?:dates?|deadlines?)\s+(?:(?:are|is|remain)\s+)?(?:estimated|expected|proposed|planned|to be announced|to be confirmed|tba|tbc|tbd))\b/i;
const MAIN_TECHNICAL_TRACK = /^main technical track(?:\s*[:–—-]\s*(?:important )?dates)?$/i;

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node;
}
function children(node: HtmlNode): HtmlNode[] {
  return 'childNodes' in node ? node.childNodes : [];
}
function attribute(node: HtmlElement, name: string): string | undefined {
  return node.attrs.find((attr) => attr.name === name)?.value;
}
function omitted(node: HtmlElement): boolean {
  if (
    OMITTED_TAGS.has(node.tagName) ||
    attribute(node, 'hidden') !== undefined ||
    attribute(node, 'inert') !== undefined ||
    attribute(node, 'aria-hidden')?.toLowerCase() === 'true'
  )
    return true;
  const style = (attribute(node, 'style') ?? '').replace(/\/\*[^]*?\*\//g, '');
  if (
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?)\s*(?:!important)?\s*(?:;|$)/i.test(
      style
    )
  )
    return true;
  return (attribute(node, 'class') ?? '')
    .split(/\s+/)
    .some((name) => /^(?:hidden|d-none|is-hidden|visually-hidden|sr-only)$/.test(name));
}
function text(node: HtmlNode): string {
  if (isElement(node) && omitted(node)) return '';
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterMap['textNode']).value;
  return children(node).map(text).join(' ').replace(/\s+/g, ' ').trim();
}

/** Browser-standard parsing avoids treating inert templates or repaired table fragments as visible rows. */
function sourceDocument(html: string): SourceDocument {
  const document = parse(html);
  const elements: HtmlElement[] = [];
  const contexts = new WeakMap<HtmlElement, Section[]>();
  let sections: Section[] = [];
  const visit = (node: HtmlNode) => {
    if (isElement(node)) {
      if (omitted(node)) return;
      const heading = /^h[1-6]$/.test(node.tagName);
      const label = text(node);
      // Editors sometimes use a short bold paragraph as a track heading instead of h2/h3.
      const trackMarker =
        ['p', 'div'].includes(node.tagName) && label.length <= 160 && label.search(NON_MAIN_SECTION) === 0;
      if (heading || trackMarker) {
        const level = heading ? Number(node.tagName[1]) : (sections[sections.length - 1]?.level ?? 1) + 1;
        sections = sections.filter((section) => section.level < level);
        sections.push({ level, heading: label, text: [] });
      }
      elements.push(node);
      contexts.set(node, [...sections]);
    } else if (node.nodeName === '#text') {
      for (const section of sections) section.text.push((node as DefaultTreeAdapterMap['textNode']).value);
    }
    for (const child of children(node)) visit(child);
  };
  visit(document);
  return { elements, contexts };
}

function safeContext(document: SourceDocument, node: HtmlElement): boolean {
  return !(document.contexts.get(node) ?? []).some(
    (section) => NON_MAIN_SECTION.test(section.heading) || UNCERTAIN_SECTION.test(section.heading)
  );
}

function mainSection(document: SourceDocument, node: HtmlElement, id: ConferenceId): Section | null {
  const sections = document.contexts.get(node) ?? [];
  const section = [...sections]
    .reverse()
    .find((section) =>
      id === 'cvpr'
        ? /^important dates$/i.test(section.heading)
        : id === 'iclr'
          ? /^deadlines$/i.test(section.heading)
          : id === 'aaai'
            ? MAIN_TECHNICAL_TRACK.test(section.heading)
            : true
    );
  return section && !UNCERTAIN_SECTION.test(section.text.join(' ')) ? section : null;
}

function tableRows(table: HtmlElement): HtmlElement[] {
  const rows: HtmlElement[] = [];
  const visit = (node: HtmlNode) => {
    if (isElement(node)) {
      if (omitted(node) || (node !== table && node.tagName === 'table')) return;
      if (node.tagName === 'tr') {
        rows.push(node);
        return;
      }
    }
    for (const child of children(node)) visit(child);
  };
  visit(table);
  return rows;
}

/** Published abbreviations are explicit fixed offsets; page/profile default zones are never used. */
export function parsePublishedDate(value: string): ConfirmedDeadline | null {
  const cleaned = value.replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, '$1').replace(/\(Anywhere on Earth\)/gi, 'AoE');
  // Offsets and multiple rendered alternatives require review rather than partial parsing.
  if (/\b(?:UTC|HST|AoE)\s*[+\-±‐-―−﹣＋－]\s*\d/i.test(cleaned)) return null;
  const calendarDates = cleaned.match(
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+['’]?(?:\d{4}|\d{2})\b/gi
  );
  const zones = cleaned.match(/\b(?:AoE|HST|UTC|PST|PDT|KST|JST|CET|CEST)\b/gi);
  if (calendarDates?.length !== 1 || zones?.length !== 1) return null;
  const dateExpression =
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+['’]?(\d{4}|\d{2})(?:\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?\s*(AoE|AOE|HST|UTC)\b/gi;
  const matches = [...cleaned.matchAll(dateExpression)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  // A date embedded in tentative prose, an opening window, or an example is not a confirmed deadline.
  const prefix = cleaned.slice(0, match.index).trim();
  const suffix = cleaned.slice((match.index ?? 0) + match[0].length).trim();
  if (
    prefix &&
    !/^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?),?$/i.test(prefix)
  )
    return null;
  if (suffix && !/^(?:or)?\s*[.*;]*$/i.test(suffix)) return null;
  const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]) + (match[3].length === 2 ? 2000 : 0);
  const zone = match[8].toUpperCase() === 'AOE' ? 'AoE' : match[8].toUpperCase();
  // An AoE date means the end of that calendar day, even when a time is omitted.
  if (match[4] === undefined && zone !== 'AoE') return null;
  let hour = match[4] === undefined ? 23 : Number(match[4]);
  const minute = match[5] === undefined ? 59 : Number(match[5]);
  const second = match[4] === undefined ? 59 : Number(match[6] ?? 0);
  if (match[7]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (match[7].toUpperCase() === 'PM' ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())
    return null;
  if (
    prefix &&
    ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(Date.UTC(year, month - 1, day)).getUTCDay()] !==
      prefix.slice(0, 3).toLowerCase()
  )
    return null;
  const offset = zone === 'AoE' ? 12 : zone === 'HST' ? 10 : 0;
  return { at: new Date(Date.UTC(year, month - 1, day, hour + offset, minute, second)).toISOString(), timeZone: zone };
}

interface ParsedSource {
  mainDeadline: ConfirmedDeadline;
  registrationDeadline: ConfirmedDeadline | null;
}

/** No scraped strings are exposed: successful parsing returns two normalized instants only. */
export function parseConferenceSource(id: ConferenceId, year: number, html: string): ParsedSource | null {
  if (html.length > MAX_SOURCE_BYTES) return null;
  const document = sourceDocument(html);
  const conference = CONFERENCE_INFO[id];
  const cycle =
    id === 'cvpr'
      ? new RegExp(`^CVPR\\s+${year}\\s+Call for Papers$`, 'i')
      : id === 'iclr'
        ? new RegExp(`^ICLR\\s+${year}\\s+Author Guidelines$`, 'i')
        : id === 'aaai'
          ? new RegExp(
              `^AAAI(?:[ -]${year}|[- ]${String(year).slice(-2)})(?:\\s+(?:Conference|Main Technical Track))?$`,
              'i'
            )
          : new RegExp(`^${conference.name}\\s+${year}\\s+(?:Meeting\\s+)?Dates(?:\\s+and\\s+Deadlines)?$`, 'i');
  if (
    !document.elements.some(
      (node) => /^h[1-3]$/.test(node.tagName) && safeContext(document, node) && cycle.test(text(node))
    )
  )
    return null;
  const policy = SOURCE_POLICIES[id];
  const main: (ConfirmedDeadline | null)[] = [];
  const registration: (ConfirmedDeadline | null)[] = [];
  for (const table of document.elements.filter((node) => node.tagName === 'table')) {
    if (!safeContext(document, table) || (!policy.scope && !mainSection(document, table, id))) continue;
    const surroundingSection = (document.contexts.get(table) ?? []).at(-1);
    if (surroundingSection && UNCERTAIN_SECTION.test(surroundingSection.text.join(' '))) continue;
    // A nested call/track table can never inherit the enclosing main track's identity.
    let ancestor: HtmlNode | null = table.parentNode;
    let nested = false;
    while (ancestor) {
      if (isElement(ancestor) && ancestor.tagName === 'table') nested = true;
      ancestor = 'parentNode' in ancestor ? ancestor.parentNode : null;
    }
    if (nested) continue;
    const tableContext = document.contexts.get(table) ?? [];
    const groups: { rows: string[][]; eligible: boolean }[] = [{ rows: [], eligible: policy.scope === null }];
    for (const row of tableRows(table)) {
      const rowContext = document.contexts.get(row) ?? [];
      // Heading changes interrupt scope even when malformed markup is repaired by the HTML parser.
      if (
        !safeContext(document, row) ||
        rowContext.length !== tableContext.length ||
        rowContext.some((section, index) => section !== tableContext[index])
      ) {
        groups.push({ rows: [], eligible: false });
        continue;
      }
      const cells = row.childNodes
        .filter((node): node is HtmlElement => isElement(node) && ['td', 'th'].includes(node.tagName) && !omitted(node))
        .map(text)
        .filter(Boolean);
      if (cells.length === 1) {
        const eligible = policy.scope
          ? policy.scope.test(cells[0])
          : /^(?:important dates|deadlines|main (?:conference )?paper submissions?|main technical track)$/i.test(
              cells[0]
            );
        groups.push({ rows: [], eligible });
        continue;
      }
      // Unknown rows cannot introduce another track and silently inherit the main-paper block.
      const mainLabel = policy.main.test(cells[0] ?? '');
      const registrationLabel = policy.registration.test(cells[0] ?? '');
      const knownOpening = id === 'icml' && /^paper submission opens for main conference$/i.test(cells[0] ?? '');
      if (cells.length >= 2 && !mainLabel && !registrationLabel && !knownOpening) {
        groups.push({ rows: [], eligible: false });
        continue;
      }
      groups[groups.length - 1].rows.push(cells);
    }
    for (const group of groups) {
      if (!group.eligible || UNCERTAIN_SECTION.test(group.rows.flat().join(' '))) continue;
      for (const cells of group.rows) {
        if (cells.length < 2) continue;
        if (policy.main.test(cells[0])) main.push(parsePublishedDate(cells[1]));
        if (policy.registration.test(cells[0])) registration.push(parsePublishedDate(cells[1]));
      }
    }
  }
  if (policy.prose) {
    for (const node of document.elements.filter((node) => ['p', 'li'].includes(node.tagName))) {
      if (!safeContext(document, node) || !mainSection(document, node, id)) continue;
      for (const sentence of text(node).split(/\.\s+|[\r\n]+/)) {
        const mainMatch = sentence.match(policy.prose);
        const registrationMatch = sentence.match(policy.registrationProse!);
        if (mainMatch) main.push(parsePublishedDate(mainMatch[1]));
        if (registrationMatch) registration.push(parsePublishedDate(registrationMatch[1]));
      }
    }
  }
  const unique = (values: (ConfirmedDeadline | null)[]) => [
    ...new Map(
      values
        .filter((value): value is ConfirmedDeadline => value !== null)
        .map((value) => [`${value.at}|${value.timeZone}`, value])
    ).values(),
  ];
  const mainDates = unique(main);
  const registrationDates = unique(registration);
  if (
    !main.length ||
    main.some((value) => value === null) ||
    mainDates.length !== 1 ||
    registration.some((value) => value === null) ||
    registrationDates.length > 1
  )
    return null;
  const submissionYear = year - Number(conference.previousYear);
  // Validate in the source's calendar, since AoE/HST may normalize into the following UTC day/year.
  const calendarYear = (deadline: ConfirmedDeadline) =>
    Number(
      new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        timeZone: deadline.timeZone === 'AoE' ? 'Etc/GMT+12' : deadline.timeZone === 'HST' ? 'Pacific/Honolulu' : 'UTC',
      }).format(new Date(deadline.at))
    );
  const sourceYear = calendarYear(mainDates[0]);
  const registrationLead = registrationDates[0]
    ? Date.parse(mainDates[0].at) - Date.parse(registrationDates[0].at)
    : null;
  if (
    sourceYear !== submissionYear ||
    (registrationDates[0] &&
      (registrationLead! <= 0 ||
        registrationLead! > 90 * DAY ||
        calendarYear(registrationDates[0]) < submissionYear - 1 ||
        calendarYear(registrationDates[0]) > submissionYear))
  )
    return null;
  return { mainDeadline: mainDates[0], registrationDeadline: registrationDates[0] ?? null };
}

interface StoredConference {
  id: ConferenceId;
  record_json: string;
  checked_at: string | null;
  verified_at: string | null;
  needs_review: number;
}

async function readRecords(db: D1Database, now: number): Promise<ConferenceDeadline[]> {
  const stored = await db
    .prepare('SELECT id, record_json, checked_at, verified_at, needs_review FROM conference_records')
    .all<StoredConference>();
  const records = new Map<ConferenceId, ConferenceDeadline>();
  for (const row of stored.results) {
    try {
      const parsed: unknown = JSON.parse(row.record_json);
      if (isConferenceDeadline(parsed) && parsed.id === row.id)
        records.set(row.id, {
          ...parsed,
          checkedAt: row.checked_at,
          verifiedAt: row.verified_at,
          needsReview: Boolean(row.needs_review),
        });
    } catch {
      /* Invalid normalized storage falls back to the reviewed public baseline. */
    }
  }
  return CONFERENCE_SEEDS.map((seed) => resolveConference(records.get(seed.id) ?? seed, now));
}

export async function getConferenceFeed(db: D1Database, now = Date.now()): Promise<ConferenceFeed> {
  return { conferences: sortConferences(await readRecords(db, now), now), generatedAt: new Date(now).toISOString() };
}

export function shouldCheckConference(record: ConferenceDeadline, now: number): boolean {
  // Daily in UTC, independently of website requests. A failed check is not a successful verification.
  return !record.checkedAt || record.checkedAt.slice(0, 10) !== new Date(now).toISOString().slice(0, 10);
}

async function fetchOfficialSource(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'text/html' },
    });
    if (!response.ok || !response.headers.get('Content-Type')?.includes('text/html')) return null;
    const length = Number(response.headers.get('Content-Length') ?? 0);
    if (length > MAX_SOURCE_BYTES || !response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let html = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return html + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_SOURCE_BYTES) {
        await reader.cancel();
        return null;
      }
      html += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** A new deadline must belong to the next expected cycle and still be upcoming. */
export function mergeConferenceCheck(record: ConferenceDeadline, html: string | null, now: number): ConferenceDeadline {
  const current = resolveConference(record, now);
  const parsed = html === null ? null : parseConferenceSource(current.id, current.year, html);
  const checkedAt = new Date(now).toISOString();
  if (!parsed || Date.parse(parsed.mainDeadline.at) <= now) return { ...current, checkedAt, needsReview: true };
  return {
    ...current,
    kind: 'confirmed',
    mainDeadline: parsed.mainDeadline,
    registrationDeadline: parsed.registrationDeadline,
    estimatedWindow: null,
    estimateSourceUrl: null,
    checkedAt,
    verifiedAt: checkedAt,
    needsReview: false,
  };
}

export async function updateConferences(db: D1Database, now = Date.now()): Promise<void> {
  const records = await readRecords(db, now);
  for (const record of records) {
    if (!shouldCheckConference(record, now)) continue;
    // Construct from fixed official hosts/path templates. Database content can never select a fetch destination.
    const sourceUrl = conferenceSourceUrl(record.id, record.year);
    const html = await fetchOfficialSource(sourceUrl);
    const updated = mergeConferenceCheck({ ...record, sourceUrl }, html, now);
    await db
      .prepare(
        `INSERT INTO conference_records (id, record_json, checked_at, verified_at, needs_review)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      record_json = excluded.record_json, checked_at = excluded.checked_at,
      verified_at = excluded.verified_at, needs_review = excluded.needs_review`
      )
      .bind(updated.id, JSON.stringify(updated), updated.checkedAt, updated.verifiedAt, Number(updated.needsReview))
      .run();
  }
}

// Kept separate from the daily cadence so a future scheduler can use the same conservative adapters.
export const CONFERENCE_CHECK_INTERVAL = DAY;
