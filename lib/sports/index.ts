import type { SportDefinition } from './types';
import { badminton } from './badminton';
import { basketball } from './basketball';
import { cricket } from './cricket';
import { football } from './football';
import { padel } from './padel';
import { pickleball } from './pickleball';
import { tableTennis } from './table_tennis';
import { tennis } from './tennis';

export type { DerivedStat, SportDefinition, StatField } from './types';

export const SPORTS: Record<string, SportDefinition> = {
  football, cricket, basketball, tennis, padel, pickleball,
  table_tennis: tableTennis, badminton,
};

export function getSport(id: string): SportDefinition | undefined {
  return SPORTS[id];
}
