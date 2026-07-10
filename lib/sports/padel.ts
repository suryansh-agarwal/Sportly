import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const padel: SportDefinition = {
  id: 'padel',
  name: 'Padel',
  formats: ['1v1', 'teams'],
  scoreLabel: 'Sets',
  statSchema: z.object({
    games_won: stat(), winners: stat(), unforced_errors: stat(), smashes: stat(),
  }).strict(),
  statFields: [
    { key: 'games_won', label: 'Games won', shortLabel: 'GW' },
    { key: 'winners', label: 'Winners', shortLabel: 'Win' },
    { key: 'unforced_errors', label: 'Unforced errors', shortLabel: 'UE' },
    { key: 'smashes', label: 'Smashes', shortLabel: 'Sm' },
  ],
  derivedStats: [],
};
