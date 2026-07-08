import { describe, expect, it } from 'vitest';
import type { MatchRow } from './types';
import { computeRecord, filterHeadToHead } from './records';

const match = (
  id: string,
  sport: string,
  type: MatchRow['match_type'],
  a: [string, number, MatchRow['participants'][0]['outcome']],
  b: [string, number, MatchRow['participants'][0]['outcome']]
): MatchRow => ({
  id,
  sport_id: sport,
  match_type: type,
  played_at: '2026-07-07',
  participants: [
    { profile_id: a[0], score: a[1], outcome: a[2] },
    { profile_id: b[0], score: b[1], outcome: b[2] },
  ],
});

describe('computeRecord', () => {
  it('aggregates official wins/losses/draws per sport', () => {
    const matches = [
      match('1', 'tennis', 'official', ['alice', 2, 'win'], ['bob', 0, 'loss']),
      match('2', 'tennis', 'official', ['alice', 0, 'loss'], ['bob', 2, 'win']),
      match('3', 'tennis', 'official', ['alice', 1, 'draw'], ['bob', 1, 'draw']),
      match('4', 'football', 'official', ['alice', 3, 'win'], ['bob', 1, 'loss']),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([
      { sportId: 'tennis', wins: 1, losses: 1, draws: 1 },
      { sportId: 'football', wins: 1, losses: 0, draws: 0 },
    ]);
  });

  it('excludes friendly matches', () => {
    const matches = [
      match('1', 'tennis', 'friendly', ['alice', 2, 'win'], ['bob', 0, 'loss']),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([]);
  });

  it('ignores matches the profile is not in', () => {
    const matches = [
      match('1', 'tennis', 'official', ['bob', 2, 'win'], ['carol', 0, 'loss']),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([]);
  });
});

describe('filterHeadToHead', () => {
  it('keeps only matches containing both profiles', () => {
    const matches = [
      match('1', 'tennis', 'official', ['alice', 2, 'win'], ['bob', 0, 'loss']),
      match('2', 'tennis', 'official', ['alice', 2, 'win'], ['carol', 0, 'loss']),
    ];
    expect(filterHeadToHead(matches, 'alice', 'bob').map((m) => m.id)).toEqual(['1']);
  });
});
