import type { MatchRow } from './types';

function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return `${n}st`;
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`;
  return `${n}th`;
}

export function matchSummary(m: MatchRow, viewerId: string): string {
  if (m.format === 'ffa') {
    const me = m.participants.find((p) => p.profile_id === viewerId);
    if (!me?.rank) return '';
    return `${ordinal(me.rank)} of ${m.participants.length}`;
  }
  if (m.score_a == null || m.score_b == null) return '';
  const mySide = m.participants.find((p) => p.profile_id === viewerId)?.side;
  return mySide === 'b' ? `${m.score_b}–${m.score_a}` : `${m.score_a}–${m.score_b}`;
}
