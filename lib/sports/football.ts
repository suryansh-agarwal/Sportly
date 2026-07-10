import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const football: SportDefinition = {
  id: 'football',
  name: 'Football',
  formats: ['1v1', 'teams'],
  scoreLabel: 'Goals',
  statSchema: z.object({
    goals: stat(), assists: stat(), saves: stat(), yellow_cards: stat(), red_cards: stat(),
  }).strict(),
  statFields: [
    { key: 'goals', label: 'Goals', shortLabel: 'G' },
    { key: 'assists', label: 'Assists', shortLabel: 'A' },
    { key: 'saves', label: 'Saves', shortLabel: 'Sv' },
    { key: 'yellow_cards', label: 'Yellow cards', shortLabel: 'YC' },
    { key: 'red_cards', label: 'Red cards', shortLabel: 'RC' },
  ],
  derivedStats: [],
};
