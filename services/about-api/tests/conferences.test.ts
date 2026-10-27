import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONFERENCE_SEEDS, CONFERENCE_BASELINE_AT } from '../../../src/data/conferences';
import {
  conferenceCountdown,
  deadlineCountdown,
  formatEstimatedWindow,
  formatPublishedDeadline,
  isConferenceFeed,
  nextConferenceCycle,
  nextConferenceActionAt,
  primaryConferenceDeadline,
  registrationIsClosed,
  relativeConferenceLabel,
  resolveConference,
  sortConferences,
} from '../../../src/lib/about/conferences';
import type { ConferenceDeadline, ConferenceId } from '../../../src/lib/about/contracts';
import {
  getConferenceFeed,
  mergeConferenceCheck,
  parseConferenceSource,
  parsePublishedDate,
  shouldCheckConference,
  updateConferences,
} from '../src/conferences';
import { testDatabase } from './database';

const now = Date.parse('2026-10-27T17:30:00Z');
const seed = (id: ConferenceId) => structuredClone(CONFERENCE_SEEDS.find((record) => record.id === id)!);
const row = (label: string, date: string) => `<tr><td></td><td>${label}</td><td>${date}</td></tr>`;
const cvpr = (date = 'Nov 16, 2026 11:59 PM AoE') =>
  `<h1>CVPR 2027 Call for Papers</h1><h3>Important Dates</h3><table>${row('Paper Enrollment Deadline*', 'Nov 10, 2026 11:59 PM AoE')}${row('Submission Deadline*', date)}</table>`;
const conflictingCvpr = () =>
  cvpr().replace('</table>', `${row('Submission Deadline*', 'Nov 18 2026 23:59 AoE')}</table>`);

test('reviewed baseline sorts upcoming submissions rather than conference meeting dates', () => {
  assert.deepEqual(
    sortConferences(CONFERENCE_SEEDS, now).map((record) => record.id),
    ['cvpr', 'icml', 'iccv', 'neurips', 'aaai', 'iclr', 'eccv']
  );
  assert.equal(relativeConferenceLabel(seed('cvpr'), now), 'Next month');
  assert.equal(relativeConferenceLabel(seed('icml'), now), 'About 3 months away');
  assert.equal(relativeConferenceLabel(seed('icml'), Date.parse('2027-01-02T00:00:00Z')), 'This month');
  assert.equal(formatEstimatedWindow(seed('aaai').estimatedWindow!), 'July–August 2027');
  assert.equal(formatEstimatedWindow(seed('icml').estimatedWindow!), 'January 2027');
});

test('published row time zones normalize AoE, HST and UTC correctly', () => {
  assert.deepEqual(parsePublishedDate('Nov 16, 2026 11:59 PM AOE'), {
    at: '2026-11-17T11:59:00.000Z',
    timeZone: 'AoE',
  });
  assert.deepEqual(parsePublishedDate("Mar 07 '27 11:59 PM HST"), { at: '2027-03-08T09:59:00.000Z', timeZone: 'HST' });
  assert.deepEqual(parsePublishedDate("Mar 05 '28 10:00 PM UTC"), { at: '2028-03-05T22:00:00.000Z', timeZone: 'UTC' });
  assert.deepEqual(parsePublishedDate("Jan 28 '27 (Anywhere on Earth)"), {
    at: '2027-01-29T11:59:59.000Z',
    timeZone: 'AoE',
  });
  assert.equal(formatPublishedDeadline(seed('cvpr').mainDeadline!), 'Nov 16, 2026, 23:59 AoE');
  assert.match(formatPublishedDeadline({ at: '2027-03-08T09:59:00Z', timeZone: 'HST' }), /Mar 7, 2027, 23:59 HST/);
  assert.match(formatPublishedDeadline({ at: '2028-03-05T22:00:00Z', timeZone: 'UTC' }), /Mar 5, 2028, 22:00 UTC/);
  assert.equal(parsePublishedDate('Mar 05 2028 10:00 PM'), null);
  assert.equal(parsePublishedDate('Feb 30 2028 10:00 PM UTC'), null);
  assert.equal(parsePublishedDate('Mar 05 2028 UTC'), null);
  assert.equal(parsePublishedDate('Mar 05 2028 25:00 UTC'), null);
  assert.equal(parsePublishedDate('Mar 05 2028 23:59 UTC-12'), null);
  for (const sign of ['−', '–', '—', '‐', '＋', '－', '±']) {
    assert.equal(parsePublishedDate(`Mar 05 2028 23:59 UTC${sign}12`), null);
  }
  assert.equal(parsePublishedDate('Mar 05 2028 23:59 AoE or 11:59 PST'), null);
  assert.equal(parsePublishedDate('Mar 05 2028 23:59 AoE or Mar 06 2028 12:00 PST'), null);
  assert.equal(parsePublishedDate('Tuesday, Nov 16 2026 23:59 AoE'), null);
  assert.equal(parsePublishedDate('Monday, Nov 16 2026 23:59 AoE')?.at, '2026-11-17T11:59:00.000Z');
});

test('annual and alternating cycles roll confirmed deadlines forward without inventing exact dates', () => {
  const expired = resolveConference(seed('cvpr'), Date.parse('2026-11-18T00:00:00Z'));
  assert.equal(expired.year, 2028);
  assert.equal(expired.kind, 'estimated');
  assert.equal(expired.mainDeadline, null);
  assert.equal(expired.registrationDeadline, null);
  assert.deepEqual(expired.estimatedWindow, { start: '2027-11', end: '2027-11' });
  assert.equal(nextConferenceCycle('iccv', 2027), 2029);
  assert.equal(nextConferenceCycle('eccv', 2028), 2030);
  assert.equal(nextConferenceCycle('eccv', 2027), 2028);
  const passed = resolveConference(seed('icml'), Date.parse('2027-02-01T00:00:00Z'));
  assert.equal(passed.year, 2027);
  assert.equal(passed.needsReview, true);
  assert.equal(relativeConferenceLabel(passed, Date.parse('2027-02-01T00:00:00Z')), 'Awaiting announcement');
});

test('countdowns use confirmed instants and registration closure remains separate', () => {
  assert.equal(deadlineCountdown('2026-11-17T11:59:00Z', Date.parse('2026-11-16T11:59:00Z')), '1 day remaining');
  assert.equal(deadlineCountdown('2026-11-17T11:59:00Z', Date.parse('2026-11-17T11:00:00Z')), '59 minutes remaining');
  assert.equal(registrationIsClosed(seed('cvpr'), Date.parse('2026-11-12T00:00:00Z')), true);
  assert.equal(registrationIsClosed(seed('cvpr'), Date.parse('2026-11-18T00:00:00Z')), false);
});

test('confirmed primary dates prioritize published registration and sort by the next upcoming action', () => {
  const cvpr = seed('cvpr');
  assert.deepEqual(primaryConferenceDeadline(cvpr), {
    deadline: cvpr.registrationDeadline,
    label: 'Paper registration',
    registration: true,
  });
  assert.equal(formatPublishedDeadline(primaryConferenceDeadline(cvpr)!.deadline), 'Nov 10, 2026, 23:59 AoE');
  assert.equal(conferenceCountdown(cvpr, Date.parse('2026-11-10T11:59:00Z')), '1 day remaining');
  assert.equal(nextConferenceActionAt(cvpr, now), Date.parse('2026-11-11T11:59:00Z'));
  const icml: ConferenceDeadline = {
    ...seed('icml'),
    kind: 'confirmed',
    estimatedWindow: null,
    registrationDeadline: { at: '2026-11-12T11:59:00Z', timeZone: 'AoE' },
    mainDeadline: { at: '2026-11-15T11:59:00Z', timeZone: 'AoE' },
  };
  assert.equal(primaryConferenceDeadline(icml)?.label, 'Abstract registration');
  assert.deepEqual(
    sortConferences([icml, cvpr], now).map((record) => record.id),
    ['cvpr', 'icml']
  );
  const afterRegistration = Date.parse('2026-11-12T12:00:00Z');
  assert.deepEqual(
    sortConferences([icml, cvpr], afterRegistration).map((record) => record.id),
    ['icml', 'cvpr']
  );
  assert.equal(nextConferenceActionAt(cvpr, afterRegistration), Date.parse(cvpr.mainDeadline!.at));
  assert.equal(relativeConferenceLabel(cvpr, afterRegistration), 'Registration closed');
  assert.equal(conferenceCountdown(cvpr, afterRegistration), 'Registration closed');
  assert.equal(primaryConferenceDeadline(cvpr)?.deadline.at, cvpr.registrationDeadline?.at);
  assert.equal(resolveConference(cvpr, afterRegistration).year, 2027);
  assert.equal(resolveConference(cvpr, afterRegistration).kind, 'confirmed');
});

test('confirmed rows without published registration fall back to clearly labeled paper submission', () => {
  const record = { ...seed('cvpr'), registrationDeadline: null };
  assert.deepEqual(primaryConferenceDeadline(record), {
    deadline: record.mainDeadline,
    label: 'Paper submission',
    registration: false,
  });
  assert.equal(formatPublishedDeadline(primaryConferenceDeadline(record)!.deadline), 'Nov 16, 2026, 23:59 AoE');
  assert.equal(conferenceCountdown(record, Date.parse('2026-11-16T11:59:00Z')), '1 day remaining');
  assert.equal(nextConferenceActionAt(record, now), Date.parse(record.mainDeadline!.at));
  assert.equal(registrationIsClosed(record, now), false);
  assert.equal(primaryConferenceDeadline(seed('icml')), null);
});

test('CVPR adapter accepts main paper and registration independently and ignores active HTML', () => {
  const parsed = parseConferenceSource(
    'cvpr',
    2027,
    cvpr() + '<script>Submission Deadline Nov 01 2026 23:59 UTC</script>'
  );
  assert.deepEqual(parsed?.mainDeadline, seed('cvpr').mainDeadline);
  assert.deepEqual(parsed?.registrationDeadline, seed('cvpr').registrationDeadline);
  assert.equal(parseConferenceSource('cvpr', 2028, cvpr()), null);
  assert.equal(parseConferenceSource('cvpr', 2027, conflictingCvpr()), null);
  assert.equal(parseConferenceSource('cvpr', 2027, cvpr('Nov 16, 2026')), null);
  assert.equal(
    parseConferenceSource(
      'cvpr',
      2027,
      '<h1>CVPR 2027</h1>' + row('Supplementary Materials Deadline', 'Nov 23, 2026 23:59 AoE')
    ),
    null
  );
});

test('date-page adapters isolate main-paper sections, rejecting event and other-track dates', () => {
  const neurips = `<h3>NeurIPS 2027 Meeting Dates</h3><table>${row('Main Conference', 'Dec 08 2027 09:00 UTC')}<tr><td colspan="5">Main Conference Paper Submission</td></tr>${row('Paper Abstract Submission Deadline', "May 04 '27 (Anywhere on Earth)")}${row('Full Paper Submission Deadline', "May 06 '27 (Anywhere on Earth)")}<tr><td colspan="5">Position Papers</td></tr>${row('Full Paper Submission Deadline', "May 12 '27 (Anywhere on Earth)")}</table>`;
  assert.equal(parseConferenceSource('neurips', 2027, neurips)?.mainDeadline.at, '2027-05-07T11:59:59.000Z');
  assert.equal(
    parseConferenceSource(
      'neurips',
      2027,
      '<h3>NeurIPS 2027</h3>' + row('Full Paper Submission Deadline', 'May 06 2027 AoE')
    ),
    null
  );
  const iccv = `<h3>ICCV 2027 Meeting Dates</h3><table><tr><td>Main Conference Paper Submission</td></tr>${row('Paper Registration Deadline', "Mar 03 '27 11:59 PM HST")}${row('Submission and Supplementary Materials Deadline', "Mar 07 '27 11:59 PM HST")}</table>`;
  assert.equal(parseConferenceSource('iccv', 2027, iccv)?.mainDeadline.at, '2027-03-08T09:59:00.000Z');
  const eccv = `<h3>ECCV 2028 Meeting Dates</h3><p>Date (Europe/Stockholm)</p><table><tr><td>Paper Submissions</td></tr>${row('Paper registration deadline', "Feb 26 '28 10:00 PM UTC")}${row('Main Conference Submission Deadline', "Mar 05 '28 10:00 PM UTC")}</table>`;
  assert.equal(parseConferenceSource('eccv', 2028, eccv)?.mainDeadline.at, '2028-03-05T22:00:00.000Z');
});

test('ICLR prose requires the matching cycle and separates abstract registration', () => {
  const html =
    '<h1>ICLR 2028 Author Guidelines</h1><h2>Deadlines</h2><p>Authors must submit paper abstracts by the abstract submission deadline of Sep 18, 2027 AOE. Please submit a genuine abstract.</p><p>The full paper submission deadline is Sep 25, 2027 AOE. Abstracts and papers must use OpenReview.</p>';
  const parsed = parseConferenceSource('iclr', 2028, html);
  assert.equal(parsed?.mainDeadline.at, '2027-09-26T11:59:59.000Z');
  assert.equal(parsed?.registrationDeadline?.at, '2027-09-19T11:59:59.000Z');
  assert.equal(parseConferenceSource('iclr', 2028, html.replaceAll('2027 AOE', '2026 AOE')), null);
});

test('AAAI parser never substitutes a workshop deadline for the main technical track', () => {
  const workshop = '<h1>AAAI-28</h1><h2>Workshop calls</h2><p>Full papers due: August 02, 2027 23:59 AoE</p>';
  assert.equal(parseConferenceSource('aaai', 2028, workshop), null);
  const main =
    '<h1>AAAI-28</h1><h2>Main Technical Track</h2><p>Abstracts due: July 21, 2027 23:59 AoE</p><p>Full papers due: July 28, 2027 23:59 AoE</p><h2>Workshop calls</h2><p>Full papers due: August 02, 2027 23:59 AoE</p>';
  assert.equal(parseConferenceSource('aaai', 2028, main)?.mainDeadline.at, '2027-07-29T11:59:00.000Z');
});

test('ambiguous or unavailable checks retain verified facts and do not refresh verifiedAt', () => {
  const baseline = seed('cvpr');
  const later = now + 86_400_000;
  for (const html of [null, '<h1>CVPR 2027</h1>', conflictingCvpr()]) {
    const result = mergeConferenceCheck(baseline, html, later);
    assert.deepEqual(result.mainDeadline, baseline.mainDeadline);
    assert.equal(result.verifiedAt, CONFERENCE_BASELINE_AT);
    assert.equal(result.checkedAt, new Date(later).toISOString());
    assert.equal(result.needsReview, true);
  }
  assert.equal(shouldCheckConference({ ...baseline, checkedAt: new Date(now).toISOString() }, now + 60_000), false);
  assert.equal(shouldCheckConference(baseline, later), true);
  assert.equal(mergeConferenceCheck(baseline, cvpr(), later).verifiedAt, new Date(later).toISOString());
});

test('relative month labels use the published calendar at UTC month boundaries', () => {
  const aoe = {
    ...seed('cvpr'),
    registrationDeadline: { at: '2026-12-01T11:59:00.000Z', timeZone: 'AoE' },
    mainDeadline: { at: '2026-12-06T11:59:00.000Z', timeZone: 'AoE' },
  };
  assert.equal(relativeConferenceLabel(aoe, Date.parse('2026-11-15T00:00:00Z')), 'This month');
  assert.equal(relativeConferenceLabel(aoe, Date.parse('2026-12-01T01:00:00Z')), 'This month');
  const hst = {
    ...seed('iccv'),
    kind: 'confirmed' as const,
    estimatedWindow: null,
    registrationDeadline: { at: '2027-04-01T09:59:00.000Z', timeZone: 'HST' },
    mainDeadline: { at: '2027-04-08T09:59:00.000Z', timeZone: 'HST' },
  };
  assert.equal(relativeConferenceLabel(hst, Date.parse('2027-03-15T00:00:00Z')), 'This month');
  assert.equal(relativeConferenceLabel(hst, Date.parse('2027-02-15T00:00:00Z')), 'Next month');
});

test('hidden and inert deadline fragments cannot confirm a deadline or refresh verification', () => {
  const fragments = [
    `<template><table>${row('Submission Deadline', 'Nov 22 2026 23:59 AoE')}</table></template>`,
    ...[
      'hidden',
      'aria-hidden="true"',
      'inert',
      'style="display:none"',
      'style="display:/**/none !important"',
      'style="visibility: hidden !important"',
      'style="opacity:0"',
      'class="d-none"',
      'class="hidden"',
    ].map(
      (attribute) => `<div ${attribute}><table>${row('Submission Deadline', 'Nov 22 2026 23:59 AoE')}</table></div>`
    ),
  ];
  for (const fragment of fragments) {
    const html = `<h1>CVPR 2027 Call for Papers</h1><h3>Important Dates</h3><p>To be announced.</p>${fragment}`;
    assert.equal(parseConferenceSource('cvpr', 2027, html), null);
    const merged = mergeConferenceCheck(seed('cvpr'), html, now + 86_400_000);
    assert.equal(merged.verifiedAt, CONFERENCE_BASELINE_AT);
    assert.equal(merged.needsReview, true);
  }
});

test('tentative, estimated, opening and example text is never upgraded to a confirmed deadline', () => {
  for (const value of [
    'Tentative: Nov 16 2026 23:59 AoE',
    'Expected Nov 16 2026 23:59 AoE',
    'Nov 16 2026 23:59 AoE (subject to change)',
    'Opening Nov 16 2026 23:59 AoE',
    'Example: Nov 16 2026 23:59 AoE',
  ]) {
    assert.equal(parseConferenceSource('cvpr', 2027, cvpr(value)), null);
  }
  assert.equal(
    parseConferenceSource(
      'cvpr',
      2027,
      cvpr().replace('<table>', '<p>All deadlines are tentative and subject to change.</p><table>')
    ),
    null
  );
  const icml = `<h3>ICML 2027 Meeting Dates</h3><p>All deadlines are tentative.</p><table><tr><td>Paper Submissions</td></tr>${row('Full Paper Submission Deadline', 'Jan 28 2027 AoE')}</table>`;
  assert.equal(parseConferenceSource('icml', 2027, icml), null);
});

test('main scope never carries across tables or into nested workshop sections and tables', () => {
  const validDate = 'Jan 28 2027 AoE';
  const carry = `<h3>ICML 2027 Meeting Dates</h3><table><tr><td>Paper Submissions</td></tr></table><h3>Workshop Calls</h3><table>${row('Full Paper Submission Deadline', validDate)}</table>`;
  assert.equal(parseConferenceSource('icml', 2027, carry), null);
  const separateTables = `<h3>ICML 2027 Meeting Dates</h3><table><tr><td>Paper Submissions</td></tr></table><table>${row('Full Paper Submission Deadline', validDate)}</table>`;
  assert.equal(parseConferenceSource('icml', 2027, separateTables), null);
  const workshopTable = `<h3>ICML 2027 Meeting Dates</h3><h3>Workshop Calls</h3><table><tr><td>Paper Submissions</td></tr>${row('Full Paper Submission Deadline', validDate)}</table>`;
  assert.equal(parseConferenceSource('icml', 2027, workshopTable), null);
  const cvprWorkshop = `<h1>CVPR 2027 Call for Papers</h1><h3>Important Dates</h3><h4>Workshop submissions</h4><table>${row('Submission Deadline', 'Nov 22 2026 23:59 AoE')}</table>`;
  assert.equal(parseConferenceSource('cvpr', 2027, cvprWorkshop), null);
  const innerRows = `<h1>CVPR 2027 Call for Papers</h1><h3>Important Dates</h3><table><tr><td>Workshop submissions</td></tr>${row('Submission Deadline', 'Nov 22 2026 23:59 AoE')}</table>`;
  assert.equal(parseConferenceSource('cvpr', 2027, innerRows), null);
  const nested = `<h1>CVPR 2027 Call for Papers</h1><h3>Important Dates</h3><table><tr><td>Workshop</td><td><table>${row('Submission Deadline', 'Nov 22 2026 23:59 AoE')}</table></td></tr></table>`;
  assert.equal(parseConferenceSource('cvpr', 2027, nested), null);
  const aaai =
    '<h1>AAAI-28</h1><h2>Main Technical Track</h2><p>To be announced</p><h3>Workshops</h3><p>Full papers due: July 28 2027 23:59 AoE</p>';
  assert.equal(parseConferenceSource('aaai', 2028, aaai), null);
  const iclr =
    '<h1>ICLR 2028 Author Guidelines</h1><h2>Deadlines</h2><h3>Workshops</h3><p>The full paper submission deadline is Sep 25 2027 AoE.</p>';
  assert.equal(parseConferenceSource('iclr', 2028, iclr), null);
  const textHeading =
    '<h1>AAAI-28</h1><h2>Main Technical Track</h2><p><strong>Workshop deadlines:</strong></p><p>Full papers due: July 28 2027 23:59 AoE</p>';
  assert.equal(parseConferenceSource('aaai', 2028, textHeading), null);
  const inlineWorkshop =
    '<h1>ICLR 2028 Author Guidelines</h1><h2>Deadlines</h2><p>For workshops, the full paper submission deadline is Sep 25 2027 AoE.</p>';
  assert.equal(parseConferenceSource('iclr', 2028, inlineWorkshop), null);
  const twoCellMarker = `<h3>ICML 2027 Meeting Dates</h3><table><tr><td>Paper Submissions</td></tr><tr><td>Workshop papers</td><td>Dates</td></tr>${row('Full Paper Submission Deadline', validDate)}</table>`;
  assert.equal(parseConferenceSource('icml', 2027, twoCellMarker), null);
  const unknownTrack = `<h3>ICML 2027 Meeting Dates</h3><table><tr><td>Paper Submissions</td></tr><tr><td>Special track</td><td>Dates</td></tr>${row('Full Paper Submission Deadline', validDate)}</table>`;
  assert.equal(parseConferenceSource('icml', 2027, unknownTrack), null);
});

test('registration belongs to the same submission cycle and a bounded lead-in window', () => {
  assert.equal(parseConferenceSource('cvpr', 2027, cvpr().replace('Nov 10, 2026', 'Nov 10, 2025')), null);
  assert.equal(parseConferenceSource('cvpr', 2027, cvpr().replace('Nov 10, 2026', 'Jan 10, 2026')), null);
  assert.equal(parseConferenceSource('cvpr', 2027, cvpr().replace('Nov 10, 2026', 'Nov 18, 2026')), null);
  const crossYear = `<h3>ICML 2027 Meeting Dates</h3><table><tr><td>Paper Submissions</td></tr>${row('Abstract Submission Deadline', 'Dec 30 2026 23:59 AoE')}${row('Full Paper Submission Deadline', 'Jan 28 2027 23:59 AoE')}</table>`;
  assert.equal(parseConferenceSource('icml', 2027, crossYear)?.registrationDeadline?.at, '2026-12-31T11:59:00.000Z');
});

test('public feed validator excludes nonofficial links, incomplete sets and unsafe dates', () => {
  const feed = { conferences: CONFERENCE_SEEDS, generatedAt: new Date(now).toISOString() };
  assert.equal(isConferenceFeed(feed), true);
  assert.equal(isConferenceFeed({ ...feed, conferences: CONFERENCE_SEEDS.slice(0, 6) }), false);
  assert.equal(
    isConferenceFeed({
      ...feed,
      conferences: CONFERENCE_SEEDS.map((record) => ({ ...record, sourceUrl: 'javascript:alert(1)' })),
    }),
    false
  );
  assert.equal(
    isConferenceFeed({
      ...feed,
      conferences: CONFERENCE_SEEDS.map((record) => (record.id === 'iccv' ? { ...record, year: 2028 } : record)),
    }),
    false
  );
  assert.equal(
    isConferenceFeed({
      ...feed,
      conferences: CONFERENCE_SEEDS.map((record) => ({ ...record, checkedAt: 'yesterday' })),
    }),
    false
  );
});

test('D1 retains normalized facts only and a failed daily refresh preserves old verification', async () => {
  const { db, sqlite } = testDatabase();
  sqlite.exec(readFileSync(new URL('../migrations/0002_conferences.sql', import.meta.url), 'utf8'));
  const before = await getConferenceFeed(db, now);
  assert.equal(before.conferences.length, 7);
  const originalFetch = globalThis.fetch;
  const destinations: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      destinations.push(String(input));
      return new Response('<html>PRIVATE_FETCH_ERROR</html>', { status: 503 });
    };
    await updateConferences(db, now + 86_400_000);
    const feed = await getConferenceFeed(db, now + 86_400_000);
    assert.equal(isConferenceFeed(feed), true);
    assert.ok(feed.conferences.every((record) => record.needsReview && record.verifiedAt === CONFERENCE_BASELINE_AT));
    assert.equal(feed.conferences[0].mainDeadline?.at, seed('cvpr').mainDeadline?.at);
    assert.equal(
      JSON.stringify(sqlite.prepare('SELECT * FROM conference_records').all()).includes('PRIVATE_FETCH_ERROR'),
      false
    );
    assert.equal(destinations.length, 7);
    await updateConferences(db, now + 86_400_000 + 60_000);
    assert.equal(destinations.length, 7);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});
