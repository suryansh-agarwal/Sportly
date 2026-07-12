import { describe, expect, it } from 'vitest';
import { SCORING_CONFIGS } from './configs';
import { SPORTS } from '../sports';

describe('SCORING_CONFIGS', () => {
  it('covers exactly the five racquet sports, all present in the sports registry', () => {
    expect(Object.keys(SCORING_CONFIGS).sort()).toEqual(
      ['badminton', 'padel', 'pickleball', 'table_tennis', 'tennis']
    );
    for (const id of Object.keys(SCORING_CONFIGS)) {
      expect(SPORTS[id], `${id} missing from SPORTS registry`).toBeDefined();
    }
  });
  it('rule parameters match the spec', () => {
    expect(SCORING_CONFIGS.tennis).toEqual({ variant: 'tennis', sets: 3 });
    expect(SCORING_CONFIGS.padel).toEqual({ variant: 'tennis', sets: 3 });
    expect(SCORING_CONFIGS.badminton).toEqual({ variant: 'rally', pointsPerGame: 21, cap: 30, games: 3 });
    expect(SCORING_CONFIGS.table_tennis).toEqual({ variant: 'rally', pointsPerGame: 11, cap: null, games: 5 });
    expect(SCORING_CONFIGS.pickleball).toEqual({ variant: 'rally', pointsPerGame: 11, cap: null, games: 3 });
  });
});
