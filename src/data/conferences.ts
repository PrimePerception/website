import type { ConferenceDeadline, ConferenceId } from '../lib/about/contracts';

/** A reviewed baseline, not a claim that every future cycle has been announced. */
export const CONFERENCE_BASELINE_AT = '2026-10-27T07:00:00.000Z';

export const CONFERENCE_INFO: Record<
  ConferenceId,
  {
    name: string;
    months: [number, number];
    previousYear: boolean;
    registrationLabel: ConferenceDeadline['registrationLabel'];
  }
> = {
  cvpr: { name: 'CVPR', months: [11, 11], previousYear: true, registrationLabel: 'Paper registration' },
  icml: { name: 'ICML', months: [1, 1], previousYear: false, registrationLabel: 'Abstract registration' },
  iccv: { name: 'ICCV', months: [3, 3], previousYear: false, registrationLabel: 'Paper registration' },
  neurips: { name: 'NeurIPS', months: [5, 5], previousYear: false, registrationLabel: 'Abstract registration' },
  aaai: { name: 'AAAI', months: [7, 8], previousYear: true, registrationLabel: 'Abstract registration' },
  iclr: { name: 'ICLR', months: [9, 9], previousYear: true, registrationLabel: 'Abstract registration' },
  eccv: { name: 'ECCV', months: [3, 3], previousYear: false, registrationLabel: 'Paper registration' },
};

export function conferenceSourceUrl(id: ConferenceId, year: number): string {
  switch (id) {
    case 'cvpr':
      return `https://cvpr.thecvf.com/Conferences/${year}/CallForPapers`;
    case 'icml':
      return `https://icml.cc/Conferences/${year}/Dates`;
    case 'iccv':
      return `https://iccv.thecvf.com/Conferences/${year}/Dates`;
    case 'neurips':
      return `https://neurips.cc/Conferences/${year}/Dates`;
    case 'aaai':
      return `https://aaai.org/conference/aaai/aaai-${String(year).slice(-2)}/`;
    case 'iclr':
      return `https://iclr.cc/Conferences/${year}/AuthorGuidelines`;
    case 'eccv':
      return `https://eccv.ecva.net/Conferences/${year}/Dates`;
  }
}

function estimate(id: ConferenceId, year: number, previousCycle: number): ConferenceDeadline {
  const info = CONFERENCE_INFO[id];
  const submissionYear = year - Number(info.previousYear);
  return {
    id,
    name: info.name,
    year,
    kind: 'estimated',
    mainDeadline: null,
    registrationDeadline: null,
    registrationLabel: info.registrationLabel,
    estimatedWindow: {
      start: `${submissionYear}-${String(info.months[0]).padStart(2, '0')}`,
      end: `${submissionYear}-${String(info.months[1]).padStart(2, '0')}`,
    },
    sourceUrl: conferenceSourceUrl(id, year),
    estimateSourceUrl: conferenceSourceUrl(id, previousCycle),
    verifiedAt: CONFERENCE_BASELINE_AT,
    checkedAt: CONFERENCE_BASELINE_AT,
    needsReview: false,
  };
}

/** Only CVPR's next main-paper deadline was confirmed in the reviewed baseline. */
export const CONFERENCE_SEEDS: ConferenceDeadline[] = [
  {
    ...estimate('cvpr', 2027, 2026),
    kind: 'confirmed',
    estimatedWindow: null,
    estimateSourceUrl: null,
    mainDeadline: { at: '2026-11-17T11:59:00.000Z', timeZone: 'AoE' },
    registrationDeadline: { at: '2026-11-11T11:59:00.000Z', timeZone: 'AoE' },
  },
  estimate('icml', 2027, 2026),
  estimate('iccv', 2027, 2025),
  estimate('neurips', 2027, 2026),
  estimate('aaai', 2028, 2027),
  estimate('iclr', 2028, 2027),
  estimate('eccv', 2028, 2026),
];
