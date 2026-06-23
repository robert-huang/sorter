/** Production role buckets ported from anilisttools `staff_types.py`. */

const IGNORABLE_KEYWORDS = new Set([
  'of',
  'Chief',
  'Director',
  'Executive',
  'Producer',
  'Supervisor',
  'Manager',
  'Main',
  'Desk',
  'Assistant',
  'Assistance',
  'Associate',
  'Engineer',
]);

const THEME_SONGS = new Set([
  'Theme Song',
  'Theme Song Performance',
  'Theme Song Composition',
  'Theme Song Arrangement',
]);

const OST = new Set([
  'Music',
  'Music Production',
  'Music Selection',
  'Insert Song Composition',
  'Insert Song Arrangement',
  'Insert Song Performance',
  'Background Music Singing',
]);

export const MUSIC_ROLES = new Set([...THEME_SONGS, ...OST]);

const SOUND = new Set([
  'Sound',
  'Sound Design',
  'Sound Mixing',
  'Sound Adjustment',
  'Sound Production',
  'Sound Effects',
  'Foley',
  'Recording',
  'Recording Adjustment',
  'ADR Mixing',
  'ADR Recording',
]);

export const AUDIO_ROLES = new Set([...MUSIC_ROLES, ...SOUND]);

const ART = new Set([
  'Art',
  'Art Design',
  'Art Board',
  'Illustration',
  'Concept Art',
  'Design',
  'Character Design',
  'Original Character Design',
  'Sub Character Design',
  'Costume Design',
  'Editing',
  'Layout',
  'Color Design',
  'Color Coordination',
  'Coloring',
  'Finishing',
  'Finishing Production',
  'Finishing Check',
  'Cel Finishing Check',
  'Background Art',
  'Background Art Production',
  'Paint',
  'Photography',
  'Photography Production',
  '2D Works',
  '2D Digital Corrector',
  'CG',
  'CG Modeling',
  'CG Production',
  'CG Sub Modeling',
  'CG Design',
  'CG Rigging',
  'CG Setup',
  'CG Background Art',
  'CG Assets',
  '3D Works',
  '3DCG',
  'Special Effects',
  'Monitor Graphics',
  'Technical',
  'Technical Artist',
  'Mechanical Coordinator',
  'Production Design',
  'Design Works',
  'Mechanical Design',
  'Prop Design',
  'World Design',
  'Weapon Design',
  'Creature Design',
  'Monster Design',
  'Eyecatch Illustration',
  'Endcard',
]);

const ANIMATION = new Set([
  'Layout Design',
  'Animator',
  'Animation',
  'Key Animation',
  '2nd Key Animation',
  'In-Between Animation',
  'In-Betweens',
  'In-Betweens Production',
  'In-Betweens Check',
  'CG Animation',
  'Digital Animation',
  'Action Animation',
  'Effects',
  'Effects Animation',
  'Character Animation',
  'Special Animation',
  'Weapon Animation',
  'Mechanical Animation',
  'Mechanical Animator',
  'Creature Animation',
  'Eyecatch Animation',
]);

export const VISUALS_ROLES = new Set([...ART, ...ANIMATION]);

export const WRITING_ROLES = new Set([
  'Original Story',
  'Original Creator',
  'Original Concept',
  'Series Composition',
  'Script',
  'Script Composition',
  'Storyboard',
  'Leica Reel',
]);

export const DIRECTING_ROLES = new Set([
  'Director',
  'Episode',
  'Unit',
  'Planning',
  'Co-Planning',
  'Action',
  'Technical',
]);

export const MARKETING_ROLES = new Set([
  'Title Logo Design',
  'PV Production',
  'Video Editing',
  'Online Editing',
  'Web Design',
  'Website Production',
  'Preview',
  'Videogram Production',
  'Advertising',
  'Advertising Design',
  'Program Advertising',
  'Publicity',
  'Sales Promotion',
  'Web Promotion',
  'Public Relations',
  'License',
  'Distribution License',
  'Domestic License',
  'Domestic Distribution',
  'Overseas License',
  'Overseas Sales',
]);

export const MISC_ROLES = new Set([
  'Producer',
  'Production',
  'Supervisor',
  'Assistance',
  'Organization',
  'Casting',
  'Production Generalization',
  'Production Office',
  'Production Committee',
  'Package',
  'Lab Coordinator',
  'Studio Coordination',
  'Brush Design',
  'Monitor Work',
  'ADR',
  'ADR Script',
  'ADR Prep',
  'Insert Song Lyrics',
  'Theme Song Lyrics',
]);

export const ALL_KNOWN_ROLES = new Set([
  ...AUDIO_ROLES,
  ...VISUALS_ROLES,
  ...WRITING_ROLES,
  ...DIRECTING_ROLES,
  ...MARKETING_ROLES,
  ...MISC_ROLES,
]);

/** Strip parentheticals and ignorable words from a production staff role. */
export function trimProductionRole(role: string): string {
  if (!role) {
    return 'unknown';
  }
  const base = role.split('(', 1)[0]?.trim() ?? role;
  const words = base.split(/\s+/).filter(Boolean);
  const trimmed = words.filter((word) => !IGNORABLE_KEYWORDS.has(word)).join(' ');
  return trimmed || words[words.length - 1] || base;
}

export function trimmedRoleInSet(role: string, bucket: ReadonlySet<string>): boolean {
  return bucket.has(trimProductionRole(role));
}

export function anyTrimmedRoleInSet(roles: string[], bucket: ReadonlySet<string>): boolean {
  return roles.some((role) => trimmedRoleInSet(role, bucket));
}
