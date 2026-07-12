import { describe, expect, it } from 'vitest';
import type { FixtureRow } from './standings';
import { bracketRounds } from './bracket';

const F = (round: number, position: number): FixtureRow => ({
  id: `${round}-${position}`, round, position,
  player_a: null, player_b: null, status: 'pending', match_id: null, winner_id: null,
  score_a: null, score_b: null,
});

describe('bracketRounds', () => {
  it('groups by round ascending, positions ordered', () => {
    const rounds = bracketRounds([F(2, 1), F(1, 2), F(1, 1)]);
    expect(rounds.map((r) => r.map((f) => f.id))).toEqual([['1-1', '1-2'], ['2-1']]);
  });
  it('empty input gives empty rounds', () => {
    expect(bracketRounds([])).toEqual([]);
  });
});
