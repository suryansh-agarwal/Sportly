import { describe, expect, it } from 'vitest';
import type { MatchFormat, MatchRow, MatchType, Outcome, ParticipantRow, Side } from './types';
import { computeRecord, filterHeadToHead } from './records';

const P = (id: string, side: Side | null, outcome: Outcome, rank: number | null = null): ParticipantRow =>
  ({ profile_id: id, score: null, outcome, side, rank, stats: null });

const M = (
  id: string, sport: string, type: MatchType, format: MatchFormat,
  scoreA: number | null, scoreB: number | null, participants: ParticipantRow[]
): MatchRow =>
  ({ id, sport_id: sport, match_type: type, format, played_at: '2026-07-09', score_a: scoreA, score_b: scoreB, participants });

describe('computeRecord', () => {
  it('aggregates official wins/losses/draws per sport (1v1)', () => {
    const matches = [
      M('1', 'tennis', 'official', '1v1', 2, 0, [P('alice', 'a', 'win'), P('bob', 'b', 'loss')]),
      M('2', 'tennis', 'official', '1v1', 0, 2, [P('alice', 'a', 'loss'), P('bob', 'b', 'win')]),
      M('3', 'tennis', 'official', '1v1', 1, 1, [P('alice', 'a', 'draw'), P('bob', 'b', 'draw')]),
      M('4', 'football', 'official', '1v1', 3, 1, [P('alice', 'a', 'win'), P('bob', 'b', 'loss')]),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([
      { sportId: 'tennis', wins: 1, losses: 1, draws: 1 },
      { sportId: 'football', wins: 1, losses: 0, draws: 0 },
    ]);
  });

  it('team result applies to every member of the side', () => {
    const matches = [
      M('1', 'football', 'official', 'teams', 2, 1,
        [P('alice', 'a', 'win'), P('carol', 'a', 'win'), P('bob', 'b', 'loss'), P('dave', 'b', 'loss')]),
    ];
    expect(computeRecord(matches, 'carol')).toEqual([{ sportId: 'football', wins: 1, losses: 0, draws: 0 }]);
    expect(computeRecord(matches, 'dave')).toEqual([{ sportId: 'football', wins: 0, losses: 1, draws: 0 }]);
  });

  it('ffa: rank 1 wins, others lose', () => {
    const matches = [
      M('1', 'table_tennis', 'official', 'ffa', null, null,
        [P('alice', null, 'win', 1), P('bob', null, 'loss', 2), P('carol', null, 'loss', 3)]),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([{ sportId: 'table_tennis', wins: 1, losses: 0, draws: 0 }]);
    expect(computeRecord(matches, 'bob')).toEqual([{ sportId: 'table_tennis', wins: 0, losses: 1, draws: 0 }]);
  });

  it('excludes friendly matches', () => {
    const matches = [
      M('1', 'tennis', 'friendly', '1v1', 2, 0, [P('alice', 'a', 'win'), P('bob', 'b', 'loss')]),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([]);
  });

  it('ignores matches the profile is not in', () => {
    const matches = [
      M('1', 'tennis', 'official', '1v1', 2, 0, [P('bob', 'a', 'win'), P('carol', 'b', 'loss')]),
    ];
    expect(computeRecord(matches, 'alice')).toEqual([]);
  });
});

describe('filterHeadToHead', () => {
  it('keeps sided matches with the two profiles on opposite sides', () => {
    const matches = [
      M('1', 'tennis', 'official', '1v1', 2, 0, [P('alice', 'a', 'win'), P('bob', 'b', 'loss')]),
      M('2', 'football', 'official', 'teams', 1, 0,
        [P('alice', 'a', 'win'), P('bob', 'b', 'loss'), P('carol', 'b', 'loss')]),
    ];
    expect(filterHeadToHead(matches, 'alice', 'bob').map((m) => m.id)).toEqual(['1', '2']);
  });

  it('excludes teammates on the same side', () => {
    const matches = [
      M('1', 'football', 'official', 'teams', 1, 0,
        [P('alice', 'a', 'win'), P('bob', 'a', 'win'), P('carol', 'b', 'loss')]),
    ];
    expect(filterHeadToHead(matches, 'alice', 'bob')).toEqual([]);
  });

  it('excludes ffa matches entirely', () => {
    const matches = [
      M('1', 'table_tennis', 'official', 'ffa', null, null,
        [P('alice', null, 'win', 1), P('bob', null, 'loss', 2)]),
    ];
    expect(filterHeadToHead(matches, 'alice', 'bob')).toEqual([]);
  });

  it('excludes matches missing either profile', () => {
    const matches = [
      M('1', 'tennis', 'official', '1v1', 2, 0, [P('alice', 'a', 'win'), P('carol', 'b', 'loss')]),
    ];
    expect(filterHeadToHead(matches, 'alice', 'bob')).toEqual([]);
  });
});
