import { describe, expect, it } from 'vitest';
import { deriveFfaOutcomes, deriveSideOutcomes } from './outcomes';

describe('deriveSideOutcomes', () => {
  it('higher side score wins', () => {
    expect(deriveSideOutcomes(3, 1)).toEqual({ a: 'win', b: 'loss' });
    expect(deriveSideOutcomes(0, 2)).toEqual({ a: 'loss', b: 'win' });
  });
  it('equal side scores draw', () => {
    expect(deriveSideOutcomes(2, 2)).toEqual({ a: 'draw', b: 'draw' });
  });
});

describe('deriveFfaOutcomes', () => {
  it('rank 1 wins, everyone else loses', () => {
    const out = deriveFfaOutcomes(new Map([['x', 1], ['y', 2], ['z', 3]]));
    expect(out.get('x')).toBe('win');
    expect(out.get('y')).toBe('loss');
    expect(out.get('z')).toBe('loss');
  });
  it('ties at rank 1 share the win', () => {
    const out = deriveFfaOutcomes(new Map([['x', 1], ['y', 1], ['z', 3]]));
    expect(out.get('x')).toBe('win');
    expect(out.get('y')).toBe('win');
    expect(out.get('z')).toBe('loss');
  });
});
