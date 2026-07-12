import type { FixtureRow } from './standings';

export function bracketRounds(fixtures: FixtureRow[]): FixtureRow[][] {
  const byRound = new Map<number, FixtureRow[]>();
  for (const f of fixtures) {
    const list = byRound.get(f.round) ?? [];
    list.push(f);
    byRound.set(f.round, list);
  }
  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list.sort((a, b) => a.position - b.position));
}
