import { describe, expect, it } from 'vitest';
import { foldEvents } from './engine';
import type { RacquetConfig, ScoreEvent, Side } from './types';

const TENNIS: RacquetConfig = { variant: 'tennis', sets: 3 };
const TT: RacquetConfig = { variant: 'rally', pointsPerGame: 11, cap: null, games: 5 };
const BADMINTON: RacquetConfig = { variant: 'rally', pointsPerGame: 21, cap: 30, games: 3 };

let nextId = 1;
const pts = (...sides: Side[]): ScoreEvent[] => sides.map((s) => ({ id: nextId++, type: 'point', side: s }));
const undo = (): ScoreEvent[] => [{ id: nextId++, type: 'undo', side: null }];
const seq = (...groups: ScoreEvent[][]) => groups.flat();
// N points in a row for one side
const run = (side: Side, n: number) => pts(...Array<Side>(n).fill(side));
// win one tennis game for `side` from fresh game (4 straight points)
const game = (side: Side) => run(side, 4);
// win one tennis set 6-0
const set = (side: Side) => seq(...Array.from({ length: 6 }, () => game(side)));

describe('tennis points display', () => {
  it('counts 0/15/30/40', () => {
    expect(foldEvents(TENNIS, pts('a')).points).toEqual({ a: '15', b: '0' });
    expect(foldEvents(TENNIS, pts('a', 'a', 'b')).points).toEqual({ a: '30', b: '15' });
    expect(foldEvents(TENNIS, pts('a', 'a', 'a')).points).toEqual({ a: '40', b: '0' });
  });
  it('deuce shows 40-40, advantage shows Ad', () => {
    const deuce = pts('a', 'a', 'a', 'b', 'b', 'b');
    expect(foldEvents(TENNIS, deuce).points).toEqual({ a: '40', b: '40' });
    expect(foldEvents(TENNIS, seq(deuce, pts('b'))).points).toEqual({ a: '40', b: 'Ad' });
  });
  it('advantage lost returns to deuce', () => {
    const advB = seq(pts('a', 'a', 'a', 'b', 'b', 'b'), pts('b'));
    expect(foldEvents(TENNIS, seq(advB, pts('a'))).points).toEqual({ a: '40', b: '40' });
  });
});

describe('tennis games and sets', () => {
  it('4 straight points win a game', () => {
    const s = foldEvents(TENNIS, game('a'));
    expect(s.units).toEqual([{ a: 1, b: 0 }]);
    expect(s.points).toEqual({ a: '0', b: '0' });
  });
  it('game must be won by 2 (deuce cycle)', () => {
    const s = foldEvents(TENNIS, seq(pts('a', 'a', 'a', 'b', 'b', 'b'), pts('a'), pts('a')));
    expect(s.units).toEqual([{ a: 1, b: 0 }]);
  });
  it('set won 6-0; new set starts', () => {
    const s = foldEvents(TENNIS, set('a'));
    expect(s.setsWon).toEqual({ a: 1, b: 0 });
    expect(s.units).toEqual([{ a: 6, b: 0 }, { a: 0, b: 0 }]);
  });
  it('set requires win by 2 games: 6-5 does not end the set', () => {
    const events = seq(
      ...Array.from({ length: 5 }, () => game('a')),
      ...Array.from({ length: 5 }, () => game('b')),
      game('a')
    );
    const s = foldEvents(TENNIS, events);
    expect(s.setsWon).toEqual({ a: 0, b: 0 });
    expect(s.units).toEqual([{ a: 6, b: 5 }]);
    expect(s.inTiebreak).toBe(false);
  });
});

describe('tennis tiebreak', () => {
  const sixAll = seq(
    ...Array.from({ length: 5 }, () => game('a')),
    ...Array.from({ length: 5 }, () => game('b')),
    game('a'),
    game('b')
  );
  it('enters tiebreak at 6-6 and displays raw points', () => {
    const s = foldEvents(TENNIS, sixAll);
    expect(s.inTiebreak).toBe(true);
    expect(foldEvents(TENNIS, seq(sixAll, pts('a'))).points).toEqual({ a: '1', b: '0' });
  });
  it('tiebreak to 7 win-by-2 gives the set 7-6', () => {
    const s = foldEvents(TENNIS, seq(sixAll, run('a', 7)));
    expect(s.setsWon).toEqual({ a: 1, b: 0 });
    expect(s.units[0]).toEqual({ a: 7, b: 6 });
    expect(s.inTiebreak).toBe(false);
  });
  it('tiebreak 7-6 continues until 2 clear', () => {
    const s = foldEvents(TENNIS, seq(sixAll, run('a', 6), run('b', 6), pts('a')));
    expect(s.setsWon).toEqual({ a: 0, b: 0 });
    expect(s.inTiebreak).toBe(true);
  });
});

describe('tennis match completion', () => {
  it('two sets win the match; further points ignored', () => {
    const s = foldEvents(TENNIS, seq(set('a'), set('a')));
    expect(s.isComplete).toBe(true);
    expect(s.winner).toBe('a');
    expect(s.setsWon).toEqual({ a: 2, b: 0 });
    const after = foldEvents(TENNIS, seq(set('a'), set('a'), pts('b')));
    expect(after.setsWon).toEqual({ a: 2, b: 0 });
    expect(after.isComplete).toBe(true);
  });
});

describe('rally scoring', () => {
  it('11 straight points win a table tennis game', () => {
    const s = foldEvents(TT, run('a', 11));
    expect(s.setsWon).toEqual({ a: 1, b: 0 });
    expect(s.units).toEqual([{ a: 11, b: 0 }, { a: 0, b: 0 }]);
  });
  it('10-10 requires win by 2', () => {
    const s = foldEvents(TT, seq(run('a', 10), run('b', 10), pts('a')));
    expect(s.setsWon).toEqual({ a: 0, b: 0 });
    expect(s.points).toEqual({ a: '11', b: '10' });
  });
  it('badminton caps at 30: 30-29 wins the game', () => {
    // interleaved so the margin stays within 1 until 29-29, forcing the cap (not a margin-of-2 win) to decide the game
    const rally = seq(run('a', 20), run('b', 20), ...Array.from({ length: 9 }, () => pts('a', 'b')), pts('a'));
    const s = foldEvents(BADMINTON, rally);
    // 29-29 -> a scores -> 30-29 -> game over via cap
    expect(s.units[0]).toEqual({ a: 30, b: 29 });
    expect(s.setsWon).toEqual({ a: 1, b: 0 });
  });
  it('best of 5: three games complete a table tennis match', () => {
    const s = foldEvents(TT, seq(run('a', 11), run('a', 11), run('a', 11)));
    expect(s.isComplete).toBe(true);
    expect(s.winner).toBe('a');
    expect(s.setsWon).toEqual({ a: 3, b: 0 });
  });
});

describe('undo', () => {
  it('undo cancels the last point', () => {
    const s = foldEvents(TENNIS, seq(pts('a', 'a'), undo()));
    expect(s.points).toEqual({ a: '15', b: '0' });
  });
  it('undo across a game boundary restores the game', () => {
    const s = foldEvents(TENNIS, seq(game('a'), undo()));
    expect(s.units).toEqual([{ a: 0, b: 0 }]);
    expect(s.points).toEqual({ a: '40', b: '0' });
  });
  it('undo across match completion reopens the match', () => {
    const s = foldEvents(TENNIS, seq(set('a'), set('a'), undo()));
    expect(s.isComplete).toBe(false);
    expect(s.setsWon).toEqual({ a: 1, b: 0 });
  });
  it('undo with nothing to cancel is a no-op', () => {
    const s = foldEvents(TENNIS, undo());
    expect(s.points).toEqual({ a: '0', b: '0' });
    expect(s.isComplete).toBe(false);
  });
});

describe('determinism', () => {
  it('fold is order-insensitive to input array order (sorts by id)', () => {
    const events = seq(run('a', 11));
    const shuffled = [...events].reverse();
    expect(foldEvents(TT, shuffled)).toEqual(foldEvents(TT, events));
  });
});
