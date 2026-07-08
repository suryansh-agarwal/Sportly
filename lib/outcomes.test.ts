import { describe, expect, it } from 'vitest';
import { deriveOutcomes } from './outcomes';

describe('deriveOutcomes', () => {
  it('higher score wins', () => {
    expect(deriveOutcomes(3, 1)).toEqual({ mine: 'win', theirs: 'loss' });
  });
  it('lower score loses', () => {
    expect(deriveOutcomes(0, 2)).toEqual({ mine: 'loss', theirs: 'win' });
  });
  it('equal scores draw', () => {
    expect(deriveOutcomes(2, 2)).toEqual({ mine: 'draw', theirs: 'draw' });
  });
});
