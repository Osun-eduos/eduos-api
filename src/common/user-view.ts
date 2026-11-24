import { School, User } from '@prisma/client';

/** The fields of a user that are safe to send to clients. */
export function userView(u: User & { school?: Pick<School, 'id' | 'name' | 'code'> | null }) {
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    phone: u.phone,
    role: u.role,
    schoolId: u.schoolId,
    school: u.school ? { id: u.school.id, name: u.school.name, code: u.school.code } : null,
    mustChangePassword: u.mustChangePassword,
    isActive: u.isActive,
    lockedUntil: u.lockedUntil,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}
