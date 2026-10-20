export interface TeachingTerm {
  label: string;
  upcoming?: true;
}

export interface Teaching {
  id: string;
  code: string;
  title: string;
  role: 'Teaching Assistant' | 'Instructor';
  terms: TeachingTerm[];
  description: string;
  href?: string;
}

const courseCalendarUrl = 'https://vancouver.calendar.ubc.ca/course-descriptions/subject/bmegv';

export const teachings: Teaching[] = [
  {
    id: 'bmeg-310',
    code: 'BMEG 310',
    title: 'Introduction to Bioinformatics',
    role: 'Teaching Assistant',
    terms: [{ label: 'Fall 2025' }, { label: 'Fall 2026' }],
    description:
      'Bioinformatics principles and computational tools for exploring genomics, proteomics, molecular structures, and evolutionary relationships in biology.',
    href: courseCalendarUrl,
  },
  {
    id: 'bmeg-250',
    code: 'BMEG 250',
    title: 'Cellular Physiology and Biophysics',
    role: 'Teaching Assistant',
    terms: [{ label: 'Winter 2026' }],
    description:
      'The physical principles behind cellular function, including membrane transport, signal transduction, muscle mechanochemistry, and neurotransmission.',
    href: courseCalendarUrl,
  },
  {
    id: 'bmeg-coding-bootcamp',
    code: 'CBC',
    title: 'Coding Bootcamp',
    role: 'Instructor',
    terms: [{ label: 'Summer 2026' }],
    description: 'Instructor for the BMEG Coding Bootcamp in Summer 2026.',
  },
  {
    id: 'bmeg-102',
    code: 'BMEG 102',
    title: 'Biomedical Engineering Lab',
    role: 'Teaching Assistant',
    terms: [{ label: 'Winter 2027', upcoming: true }],
    description:
      'Hands-on biomedical engineering experiments spanning hydrogel design, genetic engineering, bioinformatics, instrumentation, and the use of bioreactors.',
    href: courseCalendarUrl,
  },
];
