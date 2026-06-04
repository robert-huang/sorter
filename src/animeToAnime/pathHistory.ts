export type PathStep =
  | { kind: 'anime'; mediaId: number; title: string; coverImage: string | null }
  | { kind: 'staff'; staffId: number; name: string; image: string | null };

export function pathStepLabel(step: PathStep): string {
  return step.kind === 'anime' ? step.title : step.name;
}

export function formatPathSummary(steps: readonly PathStep[]): string {
  return steps.map(pathStepLabel).join(' → ');
}
