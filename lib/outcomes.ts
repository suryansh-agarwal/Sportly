import type { Outcome } from './types';

export function deriveSideOutcomes(scoreA: number, scoreB: number): { a: Outcome; b: Outcome } {
  if (scoreA > scoreB) return { a: 'win', b: 'loss' };
  if (scoreA < scoreB) return { a: 'loss', b: 'win' };
  return { a: 'draw', b: 'draw' };
}

export function deriveFfaOutcomes(ranks: Map<string, number>): Map<string, Outcome> {
  const outcomes = new Map<string, Outcome>();
  for (const [profileId, rank] of ranks) {
    outcomes.set(profileId, rank === 1 ? 'win' : 'loss');
  }
  return outcomes;
}
