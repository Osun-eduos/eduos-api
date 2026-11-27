import { School, User } from '@prisma/client';
import { twoStepRequired } from './two-step-policy';

/** The fields of a user that are safe to send to clients. */
export function userView(u: User & { school?: Pick<School, 'id' | 'name' | 'code'> | null }) {
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    phone: u.phone,
    role: u.role,
    schoolId: u.schoolId,
    lga: u.lga,
    school: u.school ? { id: u.school.id, name: u.school.name, code: u.school.code } : null,
    mustChangePassword: u.mustChangePassword,
    twoStepEnabled: !!(u.totpEnabledAt && u.totpSecret),
    twoStepRequired: twoStepRequired(u.role),
    isActive: u.isActive,
    lockedUntil: u.lockedUntil,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}
