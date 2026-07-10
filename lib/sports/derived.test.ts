import { describe, expect, it } from 'vitest';
import { economy, strikeRate } from './derived';

describe('strikeRate', () => {
  it('runs per 100 balls', () => expect(strikeRate({ runs: 50, balls_faced: 40 })).toBeCloseTo(125));
  it('null when balls_faced missing or zero', () => {
    expect(strikeRate({ runs: 50 })).toBeNull();
    expect(strikeRate({ runs: 50, balls_faced: 0 })).toBeNull();
  });
});

describe('economy', () => {
  it('runs conceded per over', () => expect(economy({ runs_conceded: 30, overs_bowled: 4 })).toBeCloseTo(7.5));
  it('null when overs missing or zero', () => {
    expect(economy({ runs_conceded: 30 })).toBeNull();
    expect(economy({ runs_conceded: 30, overs_bowled: 0 })).toBeNull();
  });
});
