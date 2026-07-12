import { describe, expect, it } from 'vitest';
import type { FixtureRow } from './standings';
import { computeStandings } from './standings';

const F = (
  id: string, a: string, b: string, winner: string | null, status: 'pending' | 'done' = 'done'
): FixtureRow => ({
  id, round: 1, position: 1, player_a: a, player_b: b, status,
  match_id: status === 'done' ? `m-${id}` : null, winner_id: winner,
  score_a: null, score_b: null,
});

const players = (...ids: string[]) =>
  ids.map((profileId, i) => ({ profileId, joinedAt: `2026-07-12T00:0${i}:00Z` }));

describe('computeStandings', () => {
  it('awards 3/1/0 and counts W/D/L', () => {
    const rows = computeStandings(
      [F('1', 'x', 'y', 'x'), F('2', 'x', 'z', null), F('3', 'y', 'z', 'z')],
      {},
      players('x', 'y', 'z')
    );
    const x = rows.find((r) => r.profileId === 'x')!;
    expect(x).toMatchObject({ played: 2, wins: 1, draws: 1, losses: 0, points: 4 });
    expect(rows[0].profileId).toBe('x');
  });

  it('ignores pending fixtures', () => {
    const rows = computeStandings([F('1', 'x', 'y', null, 'pending')], {}, players('x', 'y'));
    expect(rows.every((r) => r.played === 0)).toBe(true);
  });

  it('two-way points tie resolves by head-to-head', () => {
    // x and y both beat z, x lost to y head-to-head -> y first despite identical points
    const rows = computeStandings(
      [F('1', 'x', 'z', 'x'), F('2', 'y', 'z', 'y'), F('3', 'x', 'y', 'y'), F('4', 'z', 'x', 'x'), F('5', 'z', 'y', 'y')],
      {},
      players('x', 'y', 'z')
    );
    expect(rows[0].profileId).toBe('y');
    expect(rows[1].profileId).toBe('x');
  });

  it('falls back to score diff when not a two-way tie or no h2h result', () => {
    const rows = computeStandings(
      [F('1', 'x', 'y', null)],
      { x: 5, y: -5 },
      players('y', 'x') // y joined first
    );
    expect(rows[0].profileId).toBe('x'); // higher diff beats earlier join
  });

  it('earliest join breaks full ties', () => {
    const rows = computeStandings([F('1', 'x', 'y', null)], {}, players('y', 'x'));
    expect(rows[0].profileId).toBe('y');
  });
});
