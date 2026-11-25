import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthUser } from '../common/auth-user';
import { AllowPendingPassword, CurrentUser, Public } from '../common/decorators';
import { requestMeta } from '../common/request-meta';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto } from './dto/auth.dto';

export const REFRESH_COOKIE = 'eduos_rt';

/**
 * Native apps send `X-Client: mobile`. They get the refresh token in the response body (and keep it in encrypted
 * storage) instead of a cookie, and send it back in the body to refresh or sign out.
 */
const isMobile = (req: Request) => String(req.headers['x-client'] ?? '').toLowerCase() === 'mobile';
const bodyToken = (req: Request): string | undefined => (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined);

/**
 * Sign-in attempts allowed per IP address per minute (LOGIN_RATE_LIMIT, default 30). Kept generous because a
 * whole school may share one IP address; per-account lockout is the main defence against password guessing.
 */
const loginLimit = () => Number(process.env.LOGIN_RATE_LIMIT ?? 30);

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly config: ConfigService) {}

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE') !== 'false',
      sameSite: (this.config.get<string>('COOKIE_SAMESITE') ?? 'strict') as 'strict' | 'lax' | 'none',
      path: this.config.get<string>('COOKIE_PATH') ?? '/',
    };
  }

  private setCookie(res: Response, token: string, expires: Date) {
    res.cookie(REFRESH_COOKIE, token, { ...this.cookieOptions(), expires });
  }

  private reply(req: Request, res: Response, r: { accessToken: string; refreshToken: string; refreshExpiresAt: Date; user: unknown }) {
    if (isMobile(req)) return { accessToken: r.accessToken, refreshToken: r.refreshToken, refreshExpiresAt: r.refreshExpiresAt, user: r.user };
    this.setCookie(res, r.refreshToken, r.refreshExpiresAt);
    return { accessToken: r.accessToken, user: r.user };
  }

  @Public()
  @Throttle({ default: { limit: loginLimit, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.reply(req, res, await this.auth.login(dto.identifier, dto.password, requestMeta(req)));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.reply(req, res, await this.auth.refresh(isMobile(req) ? bodyToken(req) : req.cookies?.[REFRESH_COOKIE], requestMeta(req)));
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (isMobile(req)) return this.auth.logout(bodyToken(req));
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  @AllowPendingPassword()
  @Throttle({ default: { limit: loginLimit, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() me: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.reply(req, res, await this.auth.changePassword(me.id, dto.currentPassword, dto.newPassword, requestMeta(req)));
  }

  @AllowPendingPassword()
  @Get('me')
  me(@CurrentUser() me: AuthUser) {
    return this.auth.me(me.id);
  }
}
