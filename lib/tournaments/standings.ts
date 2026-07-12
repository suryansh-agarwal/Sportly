export type FixtureRow = {
  id: string;
  round: number;
  position: number;
  player_a: string | null;
  player_b: string | null;
  status: 'pending' | 'done';
  match_id: string | null;
  winner_id: string | null;
  score_a: number | null;
  score_b: number | null;
};

export type StandingsRow = {
  profileId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  scoreDiff: number;
};

export function computeStandings(
  fixtures: FixtureRow[],
  scoreDiffs: Record<string, number>,
  players: { profileId: string; joinedAt: string }[]
): StandingsRow[] {
  const rows = new Map<string, StandingsRow>();
  for (const p of players) {
    rows.set(p.profileId, {
      profileId: p.profileId, played: 0, wins: 0, draws: 0, losses: 0,
      points: 0, scoreDiff: scoreDiffs[p.profileId] ?? 0,
    });
  }
  for (const f of fixtures) {
    if (f.status !== 'done' || !f.player_a || !f.player_b) continue;
    for (const pid of [f.player_a, f.player_b]) {
      const row = rows.get(pid);
      if (!row) continue;
      row.played += 1;
      if (f.winner_id === null) { row.draws += 1; row.points += 1; }
      else if (f.winner_id === pid) { row.wins += 1; row.points += 3; }
      else { row.losses += 1; }
    }
  }
  const joinOrder = new Map(players.map((p, i) => [p.profileId, i]));
  const sorted = [...rows.values()].sort((a, b) =>
    b.points - a.points ||
    b.scoreDiff - a.scoreDiff ||
    (joinOrder.get(a.profileId)! - joinOrder.get(b.profileId)!) ||
    a.profileId.localeCompare(b.profileId)
  );
  // two-way head-to-head swap at the top (mirrors round_robin_winner)
  if (sorted.length >= 2 && sorted[0].points === sorted[1].points) {
    const h2h = fixtures.find(
      (f) =>
        f.status === 'done' &&
        ((f.player_a === sorted[0].profileId && f.player_b === sorted[1].profileId) ||
          (f.player_a === sorted[1].profileId && f.player_b === sorted[0].profileId))
    );
    if (h2h?.winner_id === sorted[1].profileId) {
      [sorted[0], sorted[1]] = [sorted[1], sorted[0]];
    }
  }
  return sorted;
}
