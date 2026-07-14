export type Outcome = 'win' | 'loss' | 'draw';
export type MatchType = 'official' | 'friendly';
export type MatchFormat = '1v1' | 'teams' | 'ffa';
export type Side = 'a' | 'b';

export type ParticipantRow = {
  profile_id: string;
  score: number | null;
  outcome: Outcome;
  side: Side | null;
  rank: number | null;
  stats: Record<string, number> | null;
  rating_delta: number | null;
  rating_after: number | null;
};

export type MatchRow = {
  id: string;
  sport_id: string;
  match_type: MatchType;
  format: MatchFormat;
  played_at: string;
  score_a: number | null;
  score_b: number | null;
  participants: ParticipantRow[];
};
