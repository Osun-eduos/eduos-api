import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from './auth-user';
import { OVERSIGHT_ROLES } from './roles';

/** True for the Ministry, LGA officers and inspectors: people who view schools without belonging to one. */
export const isOversight = (a: AuthUser) => OVERSIGHT_ROLES.includes(a.role);

/** Whether an oversight user may see a school in this LGA. LGA officers and LGA inspectors see only their own LGA. */
export const seesLga = (a: AuthUser, lga: string | null | undefined) => isOversight(a) && (!a.lga || a.lga === lga);

/** Prisma filter on schools for an oversight user. */
export const schoolsInScope = (a: AuthUser): Prisma.SchoolWhereInput => (a.lga ? { lga: a.lga } : {});

/** Throws 404 unless an oversight user may see this school. */
export function assertSeesLga(a: AuthUser, lga: string | null | undefined, what = 'School') {
  if (!seesLga(a, lga)) throw new NotFoundException(`${what} not found.`);
}
