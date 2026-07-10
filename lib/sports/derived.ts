export function strikeRate(stats: Record<string, number>): number | null {
  if (stats.runs == null || !stats.balls_faced) return null;
  return (stats.runs / stats.balls_faced) * 100;
}

export function economy(stats: Record<string, number>): number | null {
  if (stats.runs_conceded == null || !stats.overs_bowled) return null;
  return stats.runs_conceded / stats.overs_bowled;
}
