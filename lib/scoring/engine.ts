import type { RacquetConfig, ScoreEvent, ScoreState, Side, SideScores } from './types';

type Internal = {
  points: SideScores;
  units: SideScores[];
  setsWon: SideScores;
  inTiebreak: boolean;
  complete: boolean;
  winner: Side | null;
};

const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');

function initial(): Internal {
  return {
    points: { a: 0, b: 0 },
    units: [{ a: 0, b: 0 }],
    setsWon: { a: 0, b: 0 },
    inTiebreak: false,
    complete: false,
    winner: null,
  };
}

function applyPoint(config: RacquetConfig, s: Internal, side: Side): Internal {
  if (s.complete) return s;
  const n: Internal = {
    points: { ...s.points },
    units: s.units.map((u) => ({ ...u })),
    setsWon: { ...s.setsWon },
    inTiebreak: s.inTiebreak,
    complete: false,
    winner: null,
  };
  n.points[side] += 1;
  const p = n.points[side];
  const o = n.points[other(side)];

  if (config.variant === 'rally') {
    n.units[n.units.length - 1] = { ...n.points };
    const won =
      (p >= config.pointsPerGame && p - o >= 2) ||
      (config.cap != null && p >= config.cap);
    if (won) {
      n.setsWon[side] += 1;
      if (n.setsWon[side] > config.games / 2) {
        n.complete = true;
        n.winner = side;
      } else {
        n.points = { a: 0, b: 0 };
        n.units.push({ a: 0, b: 0 });
      }
    }
    return n;
  }

  // tennis variant
  const gameWon = n.inTiebreak ? p >= 7 && p - o >= 2 : p >= 4 && p - o >= 2;
  if (!gameWon) return n;

  const cur = n.units[n.units.length - 1];
  cur[side] += 1;
  n.points = { a: 0, b: 0 };
  const g = cur[side];
  const og = cur[other(side)];
  const setWon = n.inTiebreak || (g >= 6 && g - og >= 2);
  if (!setWon) {
    if (g === 6 && og === 6) n.inTiebreak = true;
    return n;
  }
  n.inTiebreak = false;
  n.setsWon[side] += 1;
  if (n.setsWon[side] > config.sets / 2) {
    n.complete = true;
    n.winner = side;
  } else {
    n.units.push({ a: 0, b: 0 });
  }
  return n;
}

const TENNIS_DISPLAY = ['0', '15', '30', '40'];

function display(config: RacquetConfig, s: Internal): { a: string; b: string } {
  if (config.variant === 'rally' || s.inTiebreak) {
    return { a: String(s.points.a), b: String(s.points.b) };
  }
  const { a, b } = s.points;
  if (a >= 3 && b >= 3) {
    if (a === b) return { a: '40', b: '40' };
    return a > b ? { a: 'Ad', b: '40' } : { a: '40', b: 'Ad' };
  }
  return { a: TENNIS_DISPLAY[Math.min(a, 3)], b: TENNIS_DISPLAY[Math.min(b, 3)] };
}

export function foldEvents(config: RacquetConfig, events: ScoreEvent[]): ScoreState {
  const stack: Side[] = [];
  for (const e of [...events].sort((x, y) => x.id - y.id)) {
    if (e.type === 'point' && e.side) stack.push(e.side);
    else if (e.type === 'undo') stack.pop();
  }
  let s = initial();
  for (const side of stack) s = applyPoint(config, s, side);
  return {
    points: display(config, s),
    units: s.units,
    setsWon: s.setsWon,
    inTiebreak: s.inTiebreak,
    isComplete: s.complete,
    winner: s.winner,
  };
}
