import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const tableTennis: SportDefinition = {
  id: 'table_tennis',
  name: 'Table Tennis',
  formats: ['1v1', 'teams', 'ffa'],
  scoreLabel: 'Games',
  statSchema: z.object({
    points_won: stat(), aces: stat(), serve_faults: stat(),
  }).strict(),
  statFields: [
    { key: 'points_won', label: 'Points won', shortLabel: 'PW' },
    { key: 'aces', label: 'Aces', shortLabel: 'Ace' },
    { key: 'serve_faults', label: 'Serve faults', shortLabel: 'SF' },
  ],
  derivedStats: [],
};
