import { Role } from '@prisma/client';

export { Role };

export const MINISTRY_ROLES: Role[] = [Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER];
export const SCHOOL_ROLES: Role[] = [Role.SCHOOL_ADMIN, Role.TEACHER, Role.PARENT];

/** Which roles each role may create, reset and deactivate. */
export const CAN_MANAGE: Record<Role, Role[]> = {
  MINISTRY_ADMIN: [Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER, Role.SCHOOL_ADMIN, Role.TEACHER, Role.PARENT],
  MINISTRY_OFFICER: [],
  SCHOOL_ADMIN: [Role.TEACHER, Role.PARENT],
  TEACHER: [],
  PARENT: [],
};

export const ROLE_LABEL: Record<Role, string> = {
  MINISTRY_ADMIN: 'Ministry administrator',
  MINISTRY_OFFICER: 'Ministry officer',
  SCHOOL_ADMIN: 'School administrator',
  TEACHER: 'Teacher',
  PARENT: 'Parent',
};
