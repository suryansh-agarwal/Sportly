import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const badminton: SportDefinition = {
  id: 'badminton',
  name: 'Badminton',
  formats: ['1v1', 'teams'],
  scoreLabel: 'Games',
  statSchema: z.object({
    points_won: stat(), aces: stat(), smash_winners: stat(),
  }).strict(),
  statFields: [
    { key: 'points_won', label: 'Points won', shortLabel: 'PW' },
    { key: 'aces', label: 'Aces', shortLabel: 'Ace' },
    { key: 'smash_winners', label: 'Smash winners', shortLabel: 'SW' },
  ],
  derivedStats: [],
};
