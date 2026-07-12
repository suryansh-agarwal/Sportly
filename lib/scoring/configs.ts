import type { RacquetConfig } from './types';

export const SCORING_CONFIGS: Record<string, RacquetConfig> = {
  tennis: { variant: 'tennis', sets: 3 },
  padel: { variant: 'tennis', sets: 3 },
  badminton: { variant: 'rally', pointsPerGame: 21, cap: 30, games: 3 },
  table_tennis: { variant: 'rally', pointsPerGame: 11, cap: null, games: 5 },
  pickleball: { variant: 'rally', pointsPerGame: 11, cap: null, games: 3 },
};
