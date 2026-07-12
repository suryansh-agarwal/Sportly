export type Side = 'a' | 'b';

export type ScoreEvent = {
  id: number;               // authoritative order (live_events.id)
  type: 'point' | 'undo';
  side: Side | null;        // null for undo
};

export type RacquetConfig =
  | { variant: 'tennis'; sets: number }                                    // best-of-N sets
  | { variant: 'rally'; pointsPerGame: number; cap: number | null; games: number }; // best-of-N games

export type SideScores = { a: number; b: number };

export type ScoreState = {
  points: { a: string; b: string };   // display: "40", "Ad", tiebreak/rally raw numbers
  units: SideScores[];                // tennis: games per set (current set last); rally: points per game (current game last)
  setsWon: SideScores;                // tennis: sets; rally: games — maps to score_a/score_b at finish
  inTiebreak: boolean;
  isComplete: boolean;
  winner: Side | null;
};
