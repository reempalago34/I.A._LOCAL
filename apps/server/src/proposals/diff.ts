import { createTwoFilesPatch } from 'diff';

export interface DiffStats {
  additions: number;
  deletions: number;
  hunks: number;
}

export function createUnifiedDiff(
  path: string,
  oldContent: string,
  newContent: string,
): {
  diff: string;
  stats: DiffStats;
} {
  const diff = createTwoFilesPatch(`a/${path}`, `b/${path}`, oldContent, newContent, '', '', {
    context: 3,
  });
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) hunks += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { diff, stats: { additions, deletions, hunks } };
}
