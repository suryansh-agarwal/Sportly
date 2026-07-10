import type { MatchRow } from './types';

export type SportRecord = {
  sportId: string;
  wins: number;
  losses: number;
  draws: number;
};

export function computeRecord(matches: MatchRow[], profileId: string): SportRecord[] {
  const bySport = new Map<string, SportRecord>();
  for (const m of matches) {
    if (m.match_type !== 'official') continue;
    const me = m.participants.find((p) => p.profile_id === profileId);
    if (!me) continue;
    let rec = bySport.get(m.sport_id);
    if (!rec) {
      rec = { sportId: m.sport_id, wins: 0, losses: 0, draws: 0 };
      bySport.set(m.sport_id, rec);
    }
    if (me.outcome === 'win') rec.wins += 1;
    else if (me.outcome === 'loss') rec.losses += 1;
    else rec.draws += 1;
  }
  return [...bySport.values()];
}

export function filterHeadToHead(matches: MatchRow[], a: string, b: string): MatchRow[] {
  return matches.filter((m) => {
    if (m.format === 'ffa') return false;
    const pa = m.participants.find((p) => p.profile_id === a);
    const pb = m.participants.find((p) => p.profile_id === b);
    return !!pa?.side && !!pb?.side && pa.side !== pb.side;
  });
}
