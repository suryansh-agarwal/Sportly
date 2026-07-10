import { z } from 'zod';
import type { SportDefinition } from './types';
import { economy, strikeRate } from './derived';

const stat = () => z.number().int().min(0).optional();

export const cricket: SportDefinition = {
  id: 'cricket',
  name: 'Cricket',
  formats: ['1v1', 'teams'],
  scoreLabel: 'Runs',
  statSchema: z.object({
    runs: stat(), balls_faced: stat(), fours: stat(), sixes: stat(),
    overs_bowled: z.number().min(0).optional(),
    runs_conceded: stat(), wickets: stat(), catches: stat(),
  }).strict(),
  statFields: [
    { key: 'runs', label: 'Runs', shortLabel: 'R' },
    { key: 'balls_faced', label: 'Balls faced', shortLabel: 'BF' },
    { key: 'fours', label: 'Fours', shortLabel: '4s' },
    { key: 'sixes', label: 'Sixes', shortLabel: '6s' },
    { key: 'overs_bowled', label: 'Overs bowled', shortLabel: 'O' },
    { key: 'runs_conceded', label: 'Runs conceded', shortLabel: 'RC' },
    { key: 'wickets', label: 'Wickets', shortLabel: 'W' },
    { key: 'catches', label: 'Catches', shortLabel: 'Ct' },
  ],
  derivedStats: [
    { key: 'strike_rate', label: 'Strike rate', shortLabel: 'SR', decimals: 1, compute: strikeRate },
    { key: 'economy', label: 'Economy', shortLabel: 'Econ', decimals: 2, compute: economy },
  ],
};
