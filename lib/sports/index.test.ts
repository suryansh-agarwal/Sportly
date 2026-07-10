import { describe, expect, it } from 'vitest';
import { SPORTS, getSport } from './index';

const CANONICAL_IDS = [
  'football', 'cricket', 'basketball', 'tennis',
  'padel', 'pickleball', 'table_tennis', 'badminton',
];

describe('SPORTS registry', () => {
  it('contains exactly the canonical sport ids', () => {
    expect(Object.keys(SPORTS).sort()).toEqual([...CANONICAL_IDS].sort());
  });

  it('every definition is internally consistent', () => {
    for (const [id, sport] of Object.entries(SPORTS)) {
      expect(sport.id).toBe(id);
      expect(sport.formats.length).toBeGreaterThan(0);
      expect(sport.statFields.length).toBeGreaterThan(0);
      // every statField key is accepted by the schema
      const sample = Object.fromEntries(sport.statFields.map((f) => [f.key, 1]));
      expect(sport.statSchema.safeParse(sample).success, `${id} schema rejects its own fields`).toBe(true);
    }
  });

  it('schemas accept empty stats, reject unknown keys and negatives', () => {
    for (const sport of Object.values(SPORTS)) {
      expect(sport.statSchema.safeParse({}).success).toBe(true);
      expect(sport.statSchema.safeParse({ bogus_key: 1 }).success).toBe(false);
      const firstKey = sport.statFields[0].key;
      expect(sport.statSchema.safeParse({ [firstKey]: -1 }).success).toBe(false);
    }
  });

  it('getSport returns definitions and undefined for unknown ids', () => {
    expect(getSport('cricket')?.name).toBe('Cricket');
    expect(getSport('quidditch')).toBeUndefined();
  });
});
