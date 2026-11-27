import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from './auth-user';

export const IS_PUBLIC = 'isPublic';
/** Route needs no sign-in. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOW_PENDING_PASSWORD = 'allowPendingPassword';
/** Route stays available while the user still has to change a temporary password. */
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);

export const ALLOW_PENDING_TWO_STEP = 'allowPendingTwoStep';
/** Route stays available while someone whose role requires two-step sign-in has not set it up yet. */
export const AllowPendingTwoStep = () => SetMetadata(ALLOW_PENDING_TWO_STEP, true);

export const ROLES = 'roles';
/** Only these roles may call the route. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
