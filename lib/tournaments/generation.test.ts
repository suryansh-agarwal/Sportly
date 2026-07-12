import { describe, expect, it } from 'vitest';

// mirrors start_tournament's round-robin circle method (0007)
function roundRobinPairs(n: number): [number, number][][] {
  const players = Array.from({ length: n }, (_, i) => i + 1);
  const padded = n % 2 === 1 ? [...players, 0] : players; // 0 = phantom bye
  const size = padded.length;
  const m = size - 1;
  const rounds: [number, number][][] = [];
  for (let r = 1; r <= m; r++) {
    const round: [number, number][] = [];
    const a1 = padded[0];
    const b1 = padded[((m - 1 + (r - 1)) % m) + 1];
    if (a1 !== 0 && b1 !== 0) round.push([a1, b1]);
    for (let k = 1; k <= size / 2 - 1; k++) {
      const a = padded[((k - 1 + (r - 1)) % m) + 1];
      const b = padded[((m - k - 1 + (r - 1)) % m) + 1];
      if (a !== 0 && b !== 0) round.push([a, b]);
    }
    rounds.push(round);
  }
  return rounds;
}

describe('round robin generation (mirrors 0007 circle method)', () => {
  for (let n = 3; n <= 9; n++) {
    it(`n=${n}: n(n-1)/2 fixtures, all pairs unique, everyone plays everyone`, () => {
      const rounds = roundRobinPairs(n);
      const all = rounds.flat();
      expect(all.length).toBe((n * (n - 1)) / 2);
      const keys = all.map(([a, b]) => [Math.min(a, b), Math.max(a, b)].join('-'));
      expect(new Set(keys).size).toBe(all.length);
      for (let i = 1; i <= n; i++) {
        expect(all.filter(([a, b]) => a === i || b === i).length).toBe(n - 1);
      }
      for (const round of rounds) {
        const seen = round.flat();
        expect(new Set(seen).size).toBe(seen.length); // nobody plays twice in a round
      }
    });
  }
});
