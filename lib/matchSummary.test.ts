import { describe, expect, it } from 'vitest';
import type { MatchRow, ParticipantRow } from './types';
import { matchSummary } from './matchSummary';

const base: Omit<MatchRow, 'participants' | 'format' | 'score_a' | 'score_b'> = {
  id: '1', sport_id: 'tennis', match_type: 'official', played_at: '2026-07-09',
};
const P = (id: string, side: 'a' | 'b' | null, rank: number | null = null): ParticipantRow =>
  ({ profile_id: id, score: null, outcome: 'win', side, rank, stats: null, rating_delta: null, rating_after: null });

describe('matchSummary', () => {
  it('shows viewer-side-first score for sided matches', () => {
    const m: MatchRow = { ...base, format: '1v1', score_a: 3, score_b: 1,
      participants: [P('alice', 'a'), P('bob', 'b')] };
    expect(matchSummary(m, 'alice')).toBe('3–1');
    expect(matchSummary(m, 'bob')).toBe('1–3');
  });
  it('shows placement for ffa', () => {
    const m: MatchRow = { ...base, format: 'ffa', score_a: null, score_b: null,
      participants: [P('alice', null, 1), P('bob', null, 2), P('carol', null, 3)] };
    expect(matchSummary(m, 'bob')).toBe('2nd of 3');
    expect(matchSummary(m, 'alice')).toBe('1st of 3');
  });
  it('empty string when data is missing', () => {
    const m: MatchRow = { ...base, format: 'teams', score_a: null, score_b: null, participants: [] };
    expect(matchSummary(m, 'alice')).toBe('');
  });
});
