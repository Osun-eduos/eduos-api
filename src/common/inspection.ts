/**
 * The infrastructure inspection checklist. The web app and the mobile app draw their forms from this, and
 * answers are checked against it. Change it by adding a new version, so old inspections still make sense.
 */
export type ItemType = 'count' | 'rating' | 'yesno' | 'choice';
export interface ChecklistItem {
  key: string;
  label: string;
  type: ItemType;
  options?: { value: string; label: string }[];
  hint?: string;
}
export interface ChecklistSection {
  key: string;
  title: string;
  items: ChecklistItem[];
}

export const RATINGS = [
  { value: 'GOOD', label: 'Good' },
  { value: 'FAIR', label: 'Fair' },
  { value: 'POOR', label: 'Poor' },
  { value: 'UNUSABLE', label: 'Unusable' },
];

export const TEMPLATE_VERSION = 1;
export const CHECKLIST: ChecklistSection[] = [
  {
    key: 'classrooms',
    title: 'Classrooms',
    items: [
      { key: 'total', label: 'Number of classrooms', type: 'count' },
      { key: 'usable', label: 'Classrooms safe to use', type: 'count' },
      { key: 'condition', label: 'General condition', type: 'rating' },
      { key: 'roofLeaks', label: 'Roof leaks', type: 'yesno' },
      { key: 'enoughSeats', label: 'Enough desks and chairs for the pupils', type: 'yesno' },
      { key: 'boards', label: 'Chalkboards or whiteboards', type: 'rating' },
    ],
  },
  {
    key: 'toilets',
    title: 'Toilets',
    items: [
      { key: 'girls', label: 'Toilets for girls', type: 'count' },
      { key: 'boys', label: 'Toilets for boys', type: 'count' },
      { key: 'staff', label: 'Toilets for staff', type: 'count' },
      { key: 'working', label: 'Toilets working', type: 'count', hint: 'Of all the toilets above' },
      { key: 'condition', label: 'Cleanliness and condition', type: 'rating' },
      { key: 'handwashing', label: 'Handwashing with water and soap', type: 'yesno' },
    ],
  },
  {
    key: 'water',
    title: 'Water',
    items: [
      {
        key: 'source', label: 'Main water source', type: 'choice',
        options: [
          { value: 'NONE', label: 'None' }, { value: 'BOREHOLE', label: 'Borehole' }, { value: 'WELL', label: 'Well' },
          { value: 'PIPED', label: 'Piped' }, { value: 'TANKER', label: 'Tanker or vendor' }, { value: 'RAIN', label: 'Rainwater' },
        ],
      },
      { key: 'working', label: 'Water available on the day', type: 'yesno' },
      { key: 'safe', label: 'Safe to drink', type: 'yesno' },
    ],
  },
  {
    key: 'power',
    title: 'Power',
    items: [
      {
        key: 'source', label: 'Main power source', type: 'choice',
        options: [{ value: 'NONE', label: 'None' }, { value: 'GRID', label: 'Grid' }, { value: 'SOLAR', label: 'Solar' }, { value: 'GENERATOR', label: 'Generator' }],
      },
      { key: 'working', label: 'Power available on the day', type: 'yesno' },
    ],
  },
  {
    key: 'safety',
    title: 'Safety and grounds',
    items: [
      { key: 'fence', label: 'Perimeter fence', type: 'choice', options: [{ value: 'NONE', label: 'None' }, { value: 'PARTIAL', label: 'Partial' }, { value: 'FULL', label: 'Full' }] },
      { key: 'gate', label: 'Gate that closes', type: 'yesno' },
      { key: 'firstAid', label: 'First aid box', type: 'yesno' },
      { key: 'fireExtinguisher', label: 'Working fire extinguisher', type: 'yesno' },
      { key: 'hazards', label: 'Dangerous structures (cracked walls, exposed wiring, open pits)', type: 'yesno' },
    ],
  },
  {
    key: 'facilities',
    title: 'Other facilities',
    items: [
      { key: 'library', label: 'Library', type: 'yesno' },
      { key: 'laboratory', label: 'Science laboratory', type: 'yesno' },
      { key: 'ict', label: 'Computer room', type: 'yesno' },
      { key: 'playground', label: 'Playground or sports field', type: 'yesno' },
    ],
  },
];

export type Answers = Record<string, Record<string, number | string | boolean>>;

/** Checks answers against the checklist. Every item is required. Returns the problems, or none. */
export function checkAnswers(raw: unknown): { answers: Answers; problems: string[] } {
  const problems: string[] = [];
  const answers: Answers = {};
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  for (const extra of Object.keys(input)) if (!CHECKLIST.some((s) => s.key === extra)) problems.push(`Unknown section "${extra}".`);
  for (const sec of CHECKLIST) {
    const got = (input[sec.key] && typeof input[sec.key] === 'object' ? input[sec.key] : {}) as Record<string, unknown>;
    answers[sec.key] = {};
    for (const extra of Object.keys(got)) if (!sec.items.some((i) => i.key === extra)) problems.push(`${sec.title}: unknown item "${extra}".`);
    for (const item of sec.items) {
      const v = got[item.key];
      const where = `${sec.title}: ${item.label}`;
      if (v === undefined || v === null || v === '') {
        problems.push(`${where} is not answered.`);
        continue;
      }
      if (item.type === 'count') {
        if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 1000) problems.push(`${where} must be a whole number from 0 to 1000.`);
      } else if (item.type === 'yesno') {
        if (typeof v !== 'boolean') problems.push(`${where} must be yes or no.`);
      } else {
        const options = item.type === 'rating' ? RATINGS : item.options!;
        if (!options.some((o) => o.value === v)) problems.push(`${where} must be one of: ${options.map((o) => o.label).join(', ')}.`);
      }
      answers[sec.key][item.key] = v as number | string | boolean;
    }
  }
  if (!problems.length) {
    const c = answers.classrooms, t = answers.toilets;
    if ((c.usable as number) > (c.total as number)) problems.push('Classrooms: more safe classrooms than classrooms.');
    if ((t.working as number) > (t.girls as number) + (t.boys as number) + (t.staff as number)) problems.push('Toilets: more working toilets than toilets.');
  }
  return { answers, problems };
}

export type Overall = 'GOOD' | 'FAIR' | 'POOR' | 'CRITICAL';

/**
 * An overall grade and the issues behind it. Critical: a danger to pupils or no usable classrooms or toilets.
 * Poor: something basic is broken or missing. Fair: something needs attention.
 */
export function assess(a: Answers): { overall: Overall; issues: { level: Overall; text: string }[] } {
  const issues: { level: Overall; text: string }[] = [];
  const add = (level: Overall, text: string) => issues.push({ level, text });
  const c = a.classrooms, t = a.toilets, w = a.water, p = a.power, s = a.safety;
  const rate = (r: unknown, what: string) => {
    if (r === 'UNUSABLE' || r === 'POOR') add('POOR', `${what} in ${r === 'UNUSABLE' ? 'unusable' : 'poor'} condition`);
    else if (r === 'FAIR') add('FAIR', `${what} only fair`);
  };
  if (s.hazards) add('CRITICAL', 'Dangerous structures on site');
  const total = c.total as number, usable = c.usable as number;
  if (total === 0 || usable === 0) add('CRITICAL', 'No classroom is safe to use');
  else if (usable / total < 0.5) add('CRITICAL', `Only ${usable} of ${total} classrooms are safe to use`);
  else if (usable < total) add('POOR', `${total - usable} of ${total} classrooms are not safe to use`);
  const toilets = (t.girls as number) + (t.boys as number) + (t.staff as number);
  if (toilets === 0 || t.working === 0) add('CRITICAL', 'No working toilets');
  else if ((t.working as number) / toilets < 0.5) add('POOR', `Only ${t.working} of ${toilets} toilets work`);
  if (toilets > 0 && t.girls === 0) add('POOR', 'No toilets for girls');
  rate(c.condition, 'Classrooms');
  rate(c.boards, 'Boards');
  rate(t.condition, 'Toilets');
  if (c.roofLeaks) add('POOR', 'Roof leaks');
  if (!c.enoughSeats) add('FAIR', 'Not enough desks and chairs');
  if (!t.handwashing) add('FAIR', 'No handwashing with soap');
  if (w.source === 'NONE') add('POOR', 'No water source');
  else if (!w.working) add('POOR', 'No water on the day');
  else if (!w.safe) add('FAIR', 'Water not safe to drink');
  if (p.source === 'NONE') add('FAIR', 'No power source');
  else if (!p.working) add('FAIR', 'No power on the day');
  if (s.fence === 'NONE') add('FAIR', 'No perimeter fence');
  if (!s.firstAid) add('FAIR', 'No first aid box');
  const order: Overall[] = ['CRITICAL', 'POOR', 'FAIR'];
  const overall = order.find((l) => issues.some((i) => i.level === l)) ?? 'GOOD';
  issues.sort((x, y) => order.indexOf(x.level) - order.indexOf(y.level));
  return { overall, issues };
}
