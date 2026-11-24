import { ClassLevel, SchoolLevel } from '@prisma/client';

export const LEVEL_ORDER: ClassLevel[] = [
  'PRIMARY_1', 'PRIMARY_2', 'PRIMARY_3', 'PRIMARY_4', 'PRIMARY_5', 'PRIMARY_6',
  'JSS_1', 'JSS_2', 'JSS_3', 'SSS_1', 'SSS_2', 'SSS_3',
];

/** Class levels each type of school teaches. */
export const LEVELS_FOR_SCHOOL: Record<SchoolLevel, ClassLevel[]> = {
  PRIMARY: LEVEL_ORDER.slice(0, 6),
  JUNIOR_SECONDARY: LEVEL_ORDER.slice(6, 9),
  SENIOR_SECONDARY: LEVEL_ORDER.slice(9, 12),
  JUNIOR_AND_SENIOR: LEVEL_ORDER.slice(6, 12),
};

export function levelLabel(level: ClassLevel) {
  const [kind, n] = level.split('_');
  return kind === 'PRIMARY' ? `Primary ${n}` : `${kind} ${n}`;
}

export function className(level: ClassLevel, arm: string) {
  return `${levelLabel(level)}${arm.length === 1 ? '' : ' '}${arm}`;
}
