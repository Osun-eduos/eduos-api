import { BadRequestException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { parseIdentifier } from '../common/identity';
import { dummyVerify, hashPassword, passwordProblem, verifyPassword } from '../common/password';
import { userView } from '../common/user-view';
import { PrismaService } from '../prisma/prisma.service';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const REUSE_GRACE_MS = 10_000;
const BAD_LOGIN = 'The email/phone or password is incorrect.';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

export interface Meta {
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private refreshDays() {
    return Number(this.config.get('REFRESH_TOKEN_DAYS') ?? 14);
  }

  async login(identifier: string, password: string, meta: Meta) {
    const id = parseIdentifier(identifier);
    const user = id ? await this.prisma.user.findFirst({ where: id, include: { school: true } }) : null;

    if (!user) {
      await dummyVerify(password);
      await this.audit.record({ action: 'auth.login_failed', meta: { reason: 'unknown_identifier' }, ip: meta.ip });
      throw new UnauthorizedException(BAD_LOGIN);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpException(
        { message: `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes, or ask your administrator to reset your password.`, code: 'ACCOUNT_LOCKED' },
        HttpStatus.LOCKED,
      );
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= MAX_FAILED;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
      });
      await this.audit.record({
        actorId: user.id, action: lock ? 'auth.account_locked' : 'auth.login_failed', targetType: 'user', targetId: user.id,
        schoolId: user.schoolId, meta: { reason: 'bad_password', attempt: failed }, ip: meta.ip,
      });
      throw new UnauthorizedException(BAD_LOGIN);
    }

    if (!user.isActive || (user.school && !user.school.isActive)) {
      await this.audit.record({ actorId: user.id, action: 'auth.login_failed', meta: { reason: 'inactive' }, schoolId: user.schoolId, ip: meta.ip });
      throw new HttpException(
        { message: 'This account has been deactivated. Contact your school or the Ministry.', code: 'ACCOUNT_INACTIVE' },
        HttpStatus.FORBIDDEN,
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      include: { school: true },
    });
    await this.audit.record({ actorId: user.id, action: 'auth.login', schoolId: user.schoolId, ip: meta.ip });
    return this.issue(updated, meta);
  }

  /** Signs a short-lived access token and stores a new refresh token. */
  async issue(user: User & { school?: any }, meta: Meta, replacing?: string) {
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role, sid: user.schoolId, lga: user.lga, mcp: user.mustChangePassword });
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshDays() * 86_400_000);
    const row = await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: sha256(refreshToken), expiresAt, ip: meta.ip, userAgent: meta.userAgent },
    });
    if (replacing) await this.prisma.refreshToken.update({ where: { id: replacing }, data: { revokedAt: new Date(), replacedBy: row.id } });
    return { accessToken, refreshToken, refreshExpiresAt: expiresAt, user: userView(user) };
  }

  /** Swaps a refresh token for a new pair. Reusing an old token signs the user out everywhere. */
  async refresh(token: string | undefined, meta: Meta) {
    if (!token) throw new UnauthorizedException('Please sign in.');
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: { include: { school: true } } } });
    if (!row) throw new UnauthorizedException('Please sign in.');
    // A token used again within a few seconds of being rotated is usually a second browser tab
    // refreshing at the same moment, not theft. Allow that; treat anything later as reuse.
    const withinGrace = row.revokedAt && row.replacedBy && Date.now() - row.revokedAt.getTime() < REUSE_GRACE_MS;
    if (row.revokedAt && !withinGrace) {
      await this.revokeAll(row.userId);
      await this.audit.record({ actorId: row.userId, action: 'auth.refresh_reuse_detected', schoolId: row.user.schoolId, ip: meta.ip });
      throw new UnauthorizedException('Your session has ended. Please sign in again.');
    }
    const u = row.user;
    if (row.expiresAt < new Date() || !u.isActive || (u.school && !u.school.isActive)) {
      throw new UnauthorizedException('Your session has ended. Please sign in again.');
    }
    return this.issue(u, meta, row.revokedAt ? undefined : row.id);
  }

  async logout(token: string | undefined) {
    if (!token) return;
    await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
  }

  revokeAll(userId: string) {
    return this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async changePassword(userId: string, current: string, next: string, meta: Meta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, current))) throw new BadRequestException('Your current password is incorrect.');
    const problem = passwordProblem(next);
    if (problem) throw new BadRequestException(problem);
    if (await verifyPassword(user.passwordHash, next)) throw new BadRequestException('Choose a password different from your current one.');

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(next), mustChangePassword: false, passwordChangedAt: new Date() },
      include: { school: true },
    });
    await this.revokeAll(userId);
    await this.audit.record({ actorId: userId, action: 'auth.password_changed', targetType: 'user', targetId: userId, schoolId: user.schoolId, ip: meta.ip });
    return this.issue(updated, meta);
  }

  async me(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { school: true } });
    return userView(u);
  }
}
