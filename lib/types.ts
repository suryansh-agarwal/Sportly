export type Outcome = 'win' | 'loss' | 'draw';
export type MatchType = 'official' | 'friendly';

export type ParticipantRow = {
  profile_id: string;
  score: number;
  outcome: Outcome;
};

export type MatchRow = {
  id: string;
  sport_id: string;
  match_type: MatchType;
  played_at: string;
  participants: ParticipantRow[];
};
