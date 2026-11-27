import { Role } from '@prisma/client';

/** Roles that see State-wide data must use two-step sign-in. Everyone else may switch it on. */
export const TWO_STEP_REQUIRED_ROLES: readonly Role[] = [Role.MINISTRY_ADMIN, Role.MINISTRY_OFFICER];

export const twoStepRequired = (role: Role) => TWO_STEP_REQUIRED_ROLES.includes(role);
