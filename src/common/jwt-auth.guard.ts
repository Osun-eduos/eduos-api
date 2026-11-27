import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ALLOW_PENDING_PASSWORD, ALLOW_PENDING_TWO_STEP, IS_PUBLIC } from './decorators';
import { AuthUser } from './auth-user';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Please sign in.');

    let payload: { sub: string; role: AuthUser['role']; sid: string | null; lga?: string | null; mcp: boolean; mfa?: boolean; tsp?: boolean };
    try {
      payload = await this.jwt.verifyAsync(header.slice(7));
    } catch {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }
    const user: AuthUser = {
      id: payload.sub, role: payload.role, schoolId: payload.sid, lga: payload.lga ?? null, mustChangePassword: payload.mcp,
      twoStepVerified: payload.mfa === true, twoStepPending: payload.tsp === true,
    };
    req.user = user;

    if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD, targets)) {
      throw new ForbiddenException({ message: 'Change your temporary password to continue.', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    if (user.twoStepPending && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_TWO_STEP, targets)) {
      throw new ForbiddenException({ message: 'Set up two-step sign-in to continue.', code: 'TWO_STEP_SETUP_REQUIRED' });
    }
    return true;
  }
}
