import type { Outcome } from './types';

export function deriveOutcomes(
  myScore: number,
  theirScore: number
): { mine: Outcome; theirs: Outcome } {
  if (myScore > theirScore) return { mine: 'win', theirs: 'loss' };
  if (myScore < theirScore) return { mine: 'loss', theirs: 'win' };
  return { mine: 'draw', theirs: 'draw' };
}
