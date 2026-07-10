import type { z } from 'zod';
import type { MatchFormat } from '../types';

export type StatField = {
  key: string;
  label: string;
  shortLabel: string;
};

export type DerivedStat = {
  key: string;
  label: string;
  shortLabel: string;
  decimals: number;
  compute: (stats: Record<string, number>) => number | null;
};

export type SportDefinition = {
  id: string;
  name: string;
  formats: ReadonlyArray<MatchFormat>;
  scoreLabel: string;
  statSchema: z.ZodTypeAny;
  statFields: StatField[];
  derivedStats: DerivedStat[];
};
