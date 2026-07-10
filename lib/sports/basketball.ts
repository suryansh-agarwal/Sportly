import { z } from 'zod';
import type { SportDefinition } from './types';

const stat = () => z.number().int().min(0).optional();

export const basketball: SportDefinition = {
  id: 'basketball',
  name: 'Basketball',
  formats: ['1v1', 'teams', 'ffa'],
  scoreLabel: 'Points',
  statSchema: z.object({
    points: stat(), rebounds: stat(), assists: stat(), steals: stat(), blocks: stat(), three_pointers: stat(),
  }).strict(),
  statFields: [
    { key: 'points', label: 'Points', shortLabel: 'PTS' },
    { key: 'rebounds', label: 'Rebounds', shortLabel: 'REB' },
    { key: 'assists', label: 'Assists', shortLabel: 'AST' },
    { key: 'steals', label: 'Steals', shortLabel: 'STL' },
    { key: 'blocks', label: 'Blocks', shortLabel: 'BLK' },
    { key: 'three_pointers', label: 'Three pointers', shortLabel: '3PT' },
  ],
  derivedStats: [],
};
