import { csvEscapeFranchiseCell } from './franchiseScoresLogic';

export const FRANCHISE_ACTIVITY_TYPE_OPTIONS = [
  'PROGRESS',
  'COMPLETED',
  'PLANNING',
  'PAUSED',
  'DROPPED',
] as const;

export type FranchiseActivityType =
  (typeof FRANCHISE_ACTIVITY_TYPE_OPTIONS)[number];

export const DEFAULT_FRANCHISE_ACTIVITY_TYPES: FranchiseActivityType[] = [
  ...FRANCHISE_ACTIVITY_TYPE_OPTIONS,
];

export type FranchiseActivity = {
  id: number;
  status: string;
  progress: string | null;
  createdAt: number;
  siteUrl: string;
  replyCount: number;
  media: {
    id: number;
    type: 'ANIME' | 'MANGA';
    title: string;
    siteUrl: string;
    format?: string | null;
    coverImage?: string | null;
  };
};

export type FranchiseActivityGroup = {
  mediaId: number;
  mediaTitle: string;
  mediaUrl: string;
  activities: FranchiseActivity[];
};

export type FranchiseActivityViewMode = 'date' | 'media';

export function formatFranchiseActivityType(
  type: FranchiseActivityType,
): string {
  const labels: Record<FranchiseActivityType, string> = {
    PROGRESS: 'Progress',
    COMPLETED: 'Completed',
    PLANNING: 'Planning',
    PAUSED: 'Paused',
    DROPPED: 'Dropped',
  };
  return labels[type];
}

export function classifyFranchiseActivity(
  activity: Pick<FranchiseActivity, 'status'>,
): FranchiseActivityType {
  const status = activity.status.trim().toLowerCase();
  if (status.startsWith('completed')) {
    return 'COMPLETED';
  }
  if (status.startsWith('plan')) {
    return 'PLANNING';
  }
  if (status.startsWith('paused')) {
    return 'PAUSED';
  }
  if (status.startsWith('dropped')) {
    return 'DROPPED';
  }
  return 'PROGRESS';
}

export function formatFranchiseActivityText(
  activity: Pick<FranchiseActivity, 'status' | 'progress'>,
): string {
  const normalizedStatus = activity.status.trim().toLowerCase();
  const status =
    normalizedStatus === 'plans to watch'
      ? 'Plan to watch'
      : normalizedStatus === 'plans to read'
        ? 'Plan to read'
        : normalizedStatus.length > 0
          ? `${normalizedStatus[0]?.toUpperCase() ?? ''}${normalizedStatus.slice(1)}`
          : 'Updated list';
  const progress = activity.progress?.trim();
  return progress ? `${status} ${progress}` : status;
}

export function formatFranchiseActivityDate(
  createdAt: number,
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(new Date(createdAt * 1000));
}

export function sortFranchiseActivitiesByDate(
  activities: readonly FranchiseActivity[],
): FranchiseActivity[] {
  return [...activities].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id - right.id,
  );
}

export function filterFranchiseActivitiesByType(
  activities: readonly FranchiseActivity[],
  selectedTypes: readonly FranchiseActivityType[],
): FranchiseActivity[] {
  if (selectedTypes.length === 0) {
    return [];
  }
  const selected = new Set(selectedTypes);
  return activities.filter((activity) =>
    selected.has(classifyFranchiseActivity(activity)),
  );
}

export function groupFranchiseActivitiesByMedia(
  activities: readonly FranchiseActivity[],
  mediaOrder: readonly number[],
): FranchiseActivityGroup[] {
  const grouped = new Map<number, FranchiseActivity[]>();
  for (const activity of sortFranchiseActivitiesByDate(activities)) {
    const current = grouped.get(activity.media.id) ?? [];
    current.push(activity);
    grouped.set(activity.media.id, current);
  }

  const orderedMediaIds = [
    ...mediaOrder.filter((mediaId) => grouped.has(mediaId)),
    ...[...grouped.keys()]
      .filter((mediaId) => !mediaOrder.includes(mediaId))
      .sort((left, right) => left - right),
  ];
  return orderedMediaIds.map((mediaId) => {
    const mediaActivities = grouped.get(mediaId) ?? [];
    const first = mediaActivities[0]!;
    return {
      mediaId,
      mediaTitle: first.media.title,
      mediaUrl: first.media.siteUrl,
      activities: mediaActivities,
    };
  });
}

function activityPlainTextRow(
  activity: FranchiseActivity,
  includeMedia: boolean,
  timeZone?: string,
): string {
  const parts = includeMedia
    ? [activity.media.title, formatFranchiseActivityText(activity)]
    : [formatFranchiseActivityText(activity)];
  parts.push(formatFranchiseActivityDate(activity.createdAt, timeZone));
  return parts.join(' — ');
}

export function buildFranchiseActivitiesPlainText(
  activities: readonly FranchiseActivity[],
  mode: FranchiseActivityViewMode,
  mediaOrder: readonly number[],
  timeZone?: string,
): string {
  if (mode === 'date') {
    return sortFranchiseActivitiesByDate(activities)
      .map((activity) => activityPlainTextRow(activity, true, timeZone))
      .join('\n');
  }
  return groupFranchiseActivitiesByMedia(activities, mediaOrder)
    .flatMap((group) => [
      group.mediaTitle,
      ...group.activities.map(
        (activity) => `  ${activityPlainTextRow(activity, false, timeZone)}`,
      ),
    ])
    .join('\n');
}

export function buildFranchiseActivitiesCsv(
  activities: readonly FranchiseActivity[],
  timeZone?: string,
): string {
  const header = 'mediaName,mediaUrl,date,activity,activityUrl';
  const rows = sortFranchiseActivitiesByDate(activities).map((activity) =>
    [
      activity.media.title,
      activity.media.siteUrl,
      formatFranchiseActivityDate(activity.createdAt, timeZone),
      formatFranchiseActivityText(activity),
      activity.siteUrl,
    ]
      .map(csvEscapeFranchiseCell)
      .join(','),
  );
  return [header, ...rows].join('\r\n');
}
