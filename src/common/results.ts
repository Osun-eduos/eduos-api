import { ClassLevel } from '@prisma/client';

export type Stage = 'PRIMARY' | 'JSS' | 'SSS';
export const stageOf = (level: ClassLevel): Stage => level.split('_')[0] as Stage;

export interface Component {
  key: string;
  label: string;
  max: number;
}

/** The starting score split for a new term. The Ministry can set a different split per term. */
export const DEFAULT_COMPONENTS: Component[] = [
  { key: 'CA1', label: 'CA 1', max: 20 },
  { key: 'CA2', label: 'CA 2', max: 20 },
  { key: 'EXAM', label: 'Exam', max: 60 },
];

export function componentsProblem(c: Component[]): string | null {
  if (!Array.isArray(c) || c.length < 1 || c.length > 6) return 'Use between one and six score components.';
  const keys = new Set<string>();
  for (const x of c) {
    if (!/^[A-Z][A-Z0-9]{0,7}$/.test(x.key)) return 'Component keys are short capitals, e.g. CA1 or EXAM.';
    if (keys.has(x.key)) return `The component ${x.key} is listed twice.`;
    keys.add(x.key);
    if (!x.label || x.label.length > 20) return 'Give each component a short label.';
    if (!Number.isInteger(x.max) || x.max < 1) return 'Each component needs a whole-number maximum.';
  }
  const total = c.reduce((s, x) => s + x.max, 0);
  return total === 100 ? null : `The components must add up to 100 marks (they add up to ${total}).`;
}

export const TERM_NAMES = ['First term', 'Second term', 'Third term'];
export const termName = (n: number) => TERM_NAMES[n - 1] ?? `Term ${n}`;

interface Subject {
  code: string;
  name: string;
  stages: Stage[];
  /** Stages where every class normally takes it. */
  core: Stage[];
}

/** Subjects offered in Osun State schools, following the national basic and senior secondary curricula. */
export const SUBJECTS: Subject[] = [
  { code: 'ENG', name: 'English', stages: ['PRIMARY', 'JSS', 'SSS'], core: ['PRIMARY', 'JSS', 'SSS'] },
  { code: 'MTH', name: 'Mathematics', stages: ['PRIMARY', 'JSS', 'SSS'], core: ['PRIMARY', 'JSS', 'SSS'] },
  { code: 'BST', name: 'Basic Science and Technology', stages: ['PRIMARY'], core: ['PRIMARY'] },
  { code: 'NVE', name: 'National Values Education', stages: ['PRIMARY'], core: ['PRIMARY'] },
  { code: 'PVS', name: 'Pre-Vocational Studies', stages: ['PRIMARY'], core: ['PRIMARY'] },
  { code: 'BSC', name: 'Basic Science', stages: ['JSS'], core: ['JSS'] },
  { code: 'BTE', name: 'Basic Technology', stages: ['JSS'], core: ['JSS'] },
  { code: 'PHE', name: 'Physical and Health Education', stages: ['PRIMARY', 'JSS'], core: ['JSS'] },
  { code: 'SOS', name: 'Social Studies', stages: ['JSS'], core: ['JSS'] },
  { code: 'CIV', name: 'Civic Education', stages: ['JSS', 'SSS'], core: ['JSS', 'SSS'] },
  { code: 'SEC', name: 'Security Education', stages: ['JSS'], core: [] },
  { code: 'BUS', name: 'Business Studies', stages: ['JSS'], core: ['JSS'] },
  { code: 'CMP', name: 'Computer Studies', stages: ['PRIMARY', 'JSS', 'SSS'], core: ['JSS'] },
  { code: 'AGR', name: 'Agricultural Science', stages: ['JSS', 'SSS'], core: ['JSS'] },
  { code: 'HEC', name: 'Home Economics', stages: ['JSS'], core: [] },
  { code: 'CCA', name: 'Cultural and Creative Arts', stages: ['PRIMARY', 'JSS'], core: ['PRIMARY', 'JSS'] },
  { code: 'YOR', name: 'Yoruba', stages: ['PRIMARY', 'JSS', 'SSS'], core: ['PRIMARY', 'JSS'] },
  { code: 'FRE', name: 'French', stages: ['PRIMARY', 'JSS', 'SSS'], core: [] },
  { code: 'ARB', name: 'Arabic', stages: ['PRIMARY', 'JSS', 'SSS'], core: [] },
  { code: 'CRS', name: 'Christian Religious Studies', stages: ['PRIMARY', 'JSS', 'SSS'], core: [] },
  { code: 'IRS', name: 'Islamic Studies', stages: ['PRIMARY', 'JSS', 'SSS'], core: [] },
  { code: 'HIS', name: 'History', stages: ['PRIMARY', 'JSS', 'SSS'], core: ['PRIMARY'] },
  { code: 'BIO', name: 'Biology', stages: ['SSS'], core: [] },
  { code: 'CHE', name: 'Chemistry', stages: ['SSS'], core: [] },
  { code: 'PHY', name: 'Physics', stages: ['SSS'], core: [] },
  { code: 'FMT', name: 'Further Mathematics', stages: ['SSS'], core: [] },
  { code: 'GEO', name: 'Geography', stages: ['SSS'], core: [] },
  { code: 'ECO', name: 'Economics', stages: ['SSS'], core: [] },
  { code: 'GOV', name: 'Government', stages: ['SSS'], core: [] },
  { code: 'LIT', name: 'Literature in English', stages: ['SSS'], core: [] },
  { code: 'COM', name: 'Commerce', stages: ['SSS'], core: [] },
  { code: 'ACC', name: 'Financial Accounting', stages: ['SSS'], core: [] },
  { code: 'TDR', name: 'Technical Drawing', stages: ['SSS'], core: [] },
  { code: 'FNU', name: 'Food and Nutrition', stages: ['SSS'], core: [] },
  { code: 'VAR', name: 'Visual Arts', stages: ['SSS'], core: [] },
  { code: 'MUS', name: 'Music', stages: ['SSS'], core: [] },
  { code: 'DPR', name: 'Data Processing', stages: ['SSS'], core: ['SSS'] },
  { code: 'MKT', name: 'Marketing', stages: ['SSS'], core: [] },
];

export const subjectByCode = new Map(SUBJECTS.map((s) => [s.code, s]));
export const subjectName = (code: string) => subjectByCode.get(code)?.name ?? code;
export const subjectsFor = (level: ClassLevel) => SUBJECTS.filter((s) => s.stages.includes(stageOf(level)));
export const coreSubjectsFor = (level: ClassLevel) => SUBJECTS.filter((s) => s.core.includes(stageOf(level)));

interface Band {
  min: number;
  grade: string;
  remark: string;
}

/** Senior secondary uses the WAEC scale; primary and junior secondary use A to F. Pass mark is 40 throughout. */
export const GRADING: Record<'BASIC' | 'SSS', Band[]> = {
  BASIC: [
    { min: 70, grade: 'A', remark: 'Excellent' },
    { min: 60, grade: 'B', remark: 'Very good' },
    { min: 50, grade: 'C', remark: 'Good' },
    { min: 45, grade: 'D', remark: 'Fair' },
    { min: 40, grade: 'E', remark: 'Pass' },
    { min: 0, grade: 'F', remark: 'Fail' },
  ],
  SSS: [
    { min: 75, grade: 'A1', remark: 'Excellent' },
    { min: 70, grade: 'B2', remark: 'Very good' },
    { min: 65, grade: 'B3', remark: 'Good' },
    { min: 60, grade: 'C4', remark: 'Credit' },
    { min: 55, grade: 'C5', remark: 'Credit' },
    { min: 50, grade: 'C6', remark: 'Credit' },
    { min: 45, grade: 'D7', remark: 'Pass' },
    { min: 40, grade: 'E8', remark: 'Pass' },
    { min: 0, grade: 'F9', remark: 'Fail' },
  ],
};

export const PASS_MARK = 40;
export const CREDIT_MARK = 50;

export const scaleFor = (level: ClassLevel) => GRADING[stageOf(level) === 'SSS' ? 'SSS' : 'BASIC'];

export function gradeFor(level: ClassLevel, total: number | null) {
  if (total === null) return null;
  const band = scaleFor(level).find((b) => total >= b.min)!;
  return { grade: band.grade, remark: band.remark };
}

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** Standard competition ranking: equal scores share a position and the next position is skipped (1, 2, 2, 4). */
export function rank<T>(items: T[], score: (t: T) => number | null): Map<T, number> {
  const scored = items.filter((i) => score(i) !== null).sort((a, b) => score(b)! - score(a)!);
  const out = new Map<T, number>();
  scored.forEach((item, i) => {
    const prev = scored[i - 1];
    out.set(item, prev !== undefined && score(prev) === score(item) ? out.get(prev)! : i + 1);
  });
  return out;
}

export function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
