import { Role } from '@prisma/client';

export { Role };

export const MINISTRY_ROLES: Role[] = [Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER];
/** Read-only oversight of schools: the Ministry state-wide, LGA officers for one LGA, inspectors state-wide or for one LGA. */
export const OVERSIGHT_ROLES: Role[] = [Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER, Role.LGA_OFFICER, Role.INSPECTOR];
/** Accounts that do not belong to a school. */
export const STATE_ROLES: Role[] = OVERSIGHT_ROLES;
export const SCHOOL_ROLES: Role[] = [Role.SCHOOL_ADMIN, Role.TEACHER, Role.PARENT];

/** Which roles each role may create, reset and deactivate. */
export const CAN_MANAGE: Record<Role, Role[]> = {
  MINISTRY_ADMIN: [Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER, Role.LGA_OFFICER, Role.INSPECTOR, Role.SCHOOL_ADMIN, Role.TEACHER, Role.PARENT],
  MINISTRY_OFFICER: [],
  LGA_OFFICER: [],
  INSPECTOR: [],
  SCHOOL_ADMIN: [Role.TEACHER, Role.PARENT],
  TEACHER: [],
  PARENT: [],
};

export const ROLE_LABEL: Record<Role, string> = {
  MINISTRY_ADMIN: 'Ministry administrator',
  MINISTRY_OFFICER: 'Ministry officer',
  LGA_OFFICER: 'LGA education officer',
  INSPECTOR: 'School inspector',
  SCHOOL_ADMIN: 'School administrator',
  TEACHER: 'Teacher',
  PARENT: 'Parent',
};
