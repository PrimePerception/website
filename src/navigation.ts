import { getPermalink } from './utils/permalinks';

const siteLinks = [
  { text: 'Home', href: getPermalink('/') },
  { text: 'Research Highlights', href: getPermalink('/research-highlights') },
  { text: 'Public Projects', href: getPermalink('/public-projects') },
  { text: 'Teaching & Service', href: getPermalink('/teachings') },
  { text: 'About', href: getPermalink('/about') },
];

export const headerData = {
  links: siteLinks,
  actions: [],
};

export const footerData = {
  links: [{ title: 'Explore', links: siteLinks }],
  secondaryLinks: [],
  socialLinks: [],
  footNote: `© ${new Date().getFullYear()} Prime Perception`,
};
