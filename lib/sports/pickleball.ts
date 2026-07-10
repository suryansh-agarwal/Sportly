import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const pickleball: SportDefinition = {
  id: 'pickleball',
  name: 'Pickleball',
  formats: ['1v1', 'teams'],
  scoreLabel: 'Games',
  statSchema: z.object({
    points_won: stat(), aces: stat(), faults: stat(),
  }).strict(),
  statFields: [
    { key: 'points_won', label: 'Points won', shortLabel: 'PW' },
    { key: 'aces', label: 'Aces', shortLabel: 'Ace' },
    { key: 'faults', label: 'Faults', shortLabel: 'F' },
  ],
  derivedStats: [],
};
