import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const tennis: SportDefinition = {
  id: 'tennis',
  name: 'Tennis',
  formats: ['1v1', 'teams'],
  scoreLabel: 'Sets',
  statSchema: z.object({
    games_won: stat(), aces: stat(), double_faults: stat(), winners: stat(), unforced_errors: stat(),
  }).strict(),
  statFields: [
    { key: 'games_won', label: 'Games won', shortLabel: 'GW' },
    { key: 'aces', label: 'Aces', shortLabel: 'Ace' },
    { key: 'double_faults', label: 'Double faults', shortLabel: 'DF' },
    { key: 'winners', label: 'Winners', shortLabel: 'Win' },
    { key: 'unforced_errors', label: 'Unforced errors', shortLabel: 'UE' },
  ],
  derivedStats: [],
};
