import { describe, expect, it } from 'vitest';
import { displayRating, formatDelta } from './display';

describe('displayRating', () => {
  it('maps the canonical goldens', () => {
    expect(displayRating(1000)).toBe(50);
    expect(displayRating(1400)).toBe(91);
    expect(displayRating(600)).toBe(9);
  });

  it('is monotonic non-decreasing across the realistic range', () => {
    let prev = -1;
    for (let r = 0; r <= 2400; r += 10) {
      const d = displayRating(r);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(100);
      prev = d;
    }
  });
});

describe('formatDelta', () => {
  it('formats a win as a positive display delta', () => {
    // 1000 -> 1020: display 50 -> 53
    expect(formatDelta(20, 1020)).toBe('+3');
  });

  it('formats a loss with a real minus sign', () => {
    // 1000 -> 980: display 50 -> 47
    expect(formatDelta(-20, 980)).toBe('−3');
  });

  it('shows ±0 when the display value does not move', () => {
    expect(formatDelta(0, 1000)).toBe('±0');
    // 1000 -> 1001 rounds to 50 -> 50
    expect(formatDelta(1, 1001)).toBe('±0');
  });
});
