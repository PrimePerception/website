import type { ImageMetadata } from 'astro';
import overview from '~/assets/images/vggt-prime-overview.png';
import acmilOverview from '~/assets/images/acmil-overview.png';
import redtOverview from '~/assets/images/redt-overview.png';
import openhistoOverview from '~/assets/images/openhisto-overview.png';

export interface LabProject {
  id: string;
  title: string;
  area: string;
  subtitle: string;
  description: string;
  href: string;
  paperHref?: string;
  codeHref?: string;
  image: ImageMetadata;
  imageAlt: string;
  tags: string[];
  year: string;
  authors: string;
}

export const featuredProject: LabProject = {
  id: 'vggt-prime',
  title: 'VGGT-Prime',
  area: 'Visual Geometry Models',
  subtitle: 'Compute-Adaptive Mixture-of-Heads for Efficient Visual Geometry Transformers',
  description:
    'Compute-adaptive attention for efficient visual geometry. VGGT-Prime routes attention heads between different computation modes to reduce the cost of reconstruction while maintaining competitive quality.',
  href: 'https://vggt-prime.github.io/',
  paperHref: 'https://arxiv.org/abs/2609.23733',
  image: overview,
  imageAlt:
    'VGGT-Prime overview showing a Mount Rushmore 3D reconstruction alongside charts comparing reconstruction quality and inference runtime.',
  tags: ['Computer vision', '3D geometry', 'Efficient models', 'View count scaling'],
  year: '2026',
  authors: 'Abteen Arab et al.',
};

export const redtProject: LabProject = {
  id: 'redt',
  title: 'ReDT',
  area: 'Visual Geometry Models',
  subtitle: 'Resolution-Decoupled Visual Geometry Transformer',
  description:
    'Resolution-decoupled attention for high-definition 3D reconstruction. ReDT maps each view to a fixed-size set of basis tokens, computes correspondences in this compact space, and projects features back to the original resolution for dense prediction.',
  href: 'https://redtmodel.github.io/redt_website/',
  paperHref: 'https://arxiv.org/pdf/2610.25517',
  image: redtOverview,
  imageAlt:
    'ReDT high-definition 3D reconstruction of a truck alongside charts comparing reconstruction quality and inference runtime.',
  tags: ['Computer vision', '3D geometry', 'Efficient models', 'Resolution count scaling'],
  year: '2026',
  authors: 'Abteen Arab et al.',
};

export const acmilProject: LabProject = {
  id: 'acmil',
  title: 'AC-MIL',
  area: 'Computational Medicine',
  subtitle: 'Context Matters: Anatomy-Aware Dual-Stream Multiple Instance Learning Framework for eGFR Prediction',
  description:
    'An anatomy-aware framework for predicting kidney function from whole-slide images. Separate glomerular and non-glomerular tissue streams are combined through bidirectional gating to predict estimated glomerular filtration rate (eGFR).',
  href: 'https://ac-mil.github.io/',
  paperHref: 'https://openreview.net/forum?id=KTfPFMntqQ',
  image: acmilOverview,
  imageAlt:
    'AC-MIL architecture: kidney tissue patches are separated into glomerular and non-glomerular streams, embedded and pooled independently, then combined through bidirectional gates for eGFR prediction.',
  tags: ['Computational medicine', 'Multiple instance learning', 'Kidney function'],
  year: '2026',
  authors: 'Abteen Arab et al.',
};

export const openhistoProject: LabProject = {
  id: 'openhisto',
  title: 'OpenHisto',
  area: 'Computational Medicine',
  subtitle: 'An end-to-end Python package for computational pathology',
  description:
    'An end-to-end Python package connecting whole-slide image acquisition, patch extraction, stain normalization and feature extraction with classification, risk and survival modelling, segmentation, vision-language analysis and visualization.',
  href: 'https://openhist.github.io/OpenHisto_Web/',
  codeHref: 'https://github.com/OpenHist/OpenHistology_Package',
  image: openhistoOverview,
  imageAlt:
    'OpenHisto pipeline: slides and metadata to patches, optional stain normalization, then parallel feature extraction and MIL prediction, segmentation, or vision-language descriptions, followed by visual outputs and exports.',
  tags: ['Computational pathology', 'Research software', 'Multimodal analysis'],
  year: '2026',
  authors: 'Abteen Arab',
};

export const projects: LabProject[] = [redtProject, featuredProject, acmilProject, openhistoProject];
