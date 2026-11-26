import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GRADING } from '../common/results';
import { PrismaService } from '../prisma/prisma.service';

export interface Band {
  min: number;
  grade: string;
  remark: string;
}
export type Scales = Record<'BASIC' | 'SSS', Band[]>;

/** The defaults the code ships with, kept so the Ministry can go back to them. */
export const DEFAULT_GRADING: Scales = JSON.parse(JSON.stringify(GRADING));

/** Problems with a grading scale, or null when it is usable. */
export function scaleProblem(name: string, bands: Band[]): string | null {
  if (!Array.isArray(bands) || bands.length < 2 || bands.length > 12) return `${name}: use between 2 and 12 grades.`;
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  const grades = new Set<string>();
  for (const b of sorted) {
    if (!Number.isInteger(b.min) || b.min < 0 || b.min > 100) return `${name}: each minimum score is a whole number from 0 to 100.`;
    const g = (b.grade ?? '').trim();
    if (!/^[A-Z][A-Z0-9+-]{0,2}$/.test(g)) return `${name}: grades are short, e.g. A, B2 or C+.`;
    if (grades.has(g)) return `${name}: the grade ${g} is used twice.`;
    grades.add(g);
    if (!b.remark?.trim() || b.remark.length > 20) return `${name}: give each grade a short remark.`;
  }
  for (let i = 1; i < sorted.length; i++) if (sorted[i].min === sorted[i - 1].min) return `${name}: two grades start at ${sorted[i].min}.`;
  if (sorted[sorted.length - 1].min !== 0) return `${name}: the lowest grade must start at 0.`;
  return null;
}

/**
 * Grading scales are stored as a setting and copied into the shared GRADING table the results code reads. Every
 * read refreshes the copy, so changes made through another API instance are picked up.
 */
@Injectable()
export class GradingService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.refresh().catch(() => undefined);
  }

  async refresh(): Promise<Scales> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'grading' } });
    const value = (row?.value as unknown as Scales | undefined) ?? DEFAULT_GRADING;
    GRADING.BASIC = value.BASIC;
    GRADING.SSS = value.SSS;
    return { BASIC: GRADING.BASIC, SSS: GRADING.SSS };
  }

  async save(actorId: string, scales: Scales) {
    for (const [name, key] of [['Basic education (A to F)', 'BASIC'], ['Senior secondary (A1 to F9)', 'SSS']] as const) {
      const p = scaleProblem(name, scales[key]);
      if (p) throw new BadRequestException(p);
    }
    const clean = (bs: Band[]) => [...bs].sort((a, b) => b.min - a.min).map((b) => ({ min: b.min, grade: b.grade.trim(), remark: b.remark.trim() }));
    const value = { BASIC: clean(scales.BASIC), SSS: clean(scales.SSS) };
    await this.prisma.setting.upsert({
      where: { key: 'grading' },
      create: { key: 'grading', value: value as unknown as Prisma.InputJsonValue, updatedById: actorId },
      update: { value: value as unknown as Prisma.InputJsonValue, updatedById: actorId },
    });
    return this.refresh();
  }

  async reset() {
    await this.prisma.setting.deleteMany({ where: { key: 'grading' } });
    return this.refresh();
  }
}
