import { BadRequestException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { parseIdentifier } from '../common/identity';
import { dummyVerify, hashPassword, isBreachedPassword, passwordProblem, verifyPassword } from '../common/password';
import { twoStepRequired } from '../common/two-step-policy';
import { userView } from '../common/user-view';
import { PrismaService } from '../prisma/prisma.service';
import { TwoStepService } from './two-step/two-step.service';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const REUSE_GRACE_MS = 10_000;
const BAD_LOGIN = 'The email/phone or password is incorrect.';
const BAD_CODE = 'That code is not right. Use the newest code from your authenticator app, or one of your recovery codes.';
/** How long someone has to type their code after a correct password, and how many tries they get. */
const CHALLENGE_MINUTES = 5;
const CHALLENGE_ATTEMPTS = 5;

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
    private readonly twoStep: TwoStepService,
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
      await this.failedAttempt(user, 'bad_password', meta);
      throw new UnauthorizedException(BAD_LOGIN);
    }

    if (!user.isActive || (user.school && !user.school.isActive)) {
      await this.audit.record({ actorId: user.id, action: 'auth.login_failed', meta: { reason: 'inactive' }, schoolId: user.schoolId, ip: meta.ip });
      throw new HttpException(
        { message: 'This account has been deactivated. Contact your school or the Ministry.', code: 'ACCOUNT_INACTIVE' },
        HttpStatus.FORBIDDEN,
      );
    }

    // With two-step sign-in on, a correct password only opens a short-lived challenge for the authenticator code.
    if (this.twoStep.enabled(user)) {
      const mfaToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + CHALLENGE_MINUTES * 60_000);
      await this.prisma.mfaChallenge.deleteMany({ where: { userId: user.id, OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date() } }] } });
      await this.prisma.mfaChallenge.create({ data: { userId: user.id, tokenHash: sha256(mfaToken), expiresAt } });
      await this.audit.record({ actorId: user.id, action: 'auth.password_ok_code_needed', schoolId: user.schoolId, ip: meta.ip });
      return { mfaRequired: true as const, mfaToken, expiresAt };
    }

    return this.signedIn(user, meta, false);
  }

  /** Second step of sign-in: the code from the authenticator app, or a recovery code. */
  async loginCode(mfaToken: string, code: string, meta: Meta) {
    const challenge = await this.prisma.mfaChallenge.findUnique({ where: { tokenHash: sha256(mfaToken) }, include: { user: { include: { school: true } } } });
    const expired = 'This sign-in has expired. Enter your email/phone and password again.';
    if (!challenge || challenge.usedAt || challenge.expiresAt < new Date() || challenge.attempts >= CHALLENGE_ATTEMPTS) {
      throw new UnauthorizedException(expired);
    }
    const user = challenge.user;
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpException(
        { message: `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes, or ask your administrator to reset your password.`, code: 'ACCOUNT_LOCKED' },
        HttpStatus.LOCKED,
      );
    }
    if (!user.isActive || (user.school && !user.school.isActive)) throw new UnauthorizedException(expired);

    // Count the attempt first, so parallel guesses cannot exceed the limit.
    const { count } = await this.prisma.mfaChallenge.updateMany({
      where: { id: challenge.id, usedAt: null, attempts: { lt: CHALLENGE_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (count !== 1) throw new UnauthorizedException(expired);

    const kind = await this.twoStep.check(user, code);
    if (!kind) {
      await this.failedAttempt(user, 'bad_code', meta);
      throw new UnauthorizedException(BAD_CODE);
    }
    const used = await this.prisma.mfaChallenge.updateMany({ where: { id: challenge.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) throw new UnauthorizedException(expired);
    if (kind === 'recovery') {
      await this.audit.record({ actorId: user.id, action: 'auth.recovery_code_used', targetType: 'user', targetId: user.id, schoolId: user.schoolId, ip: meta.ip });
    }
    return this.signedIn(user, meta, true);
  }

  private async signedIn(user: User, meta: Meta, mfa: boolean) {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      include: { school: true },
    });
    await this.audit.record({ actorId: user.id, action: 'auth.login', schoolId: user.schoolId, meta: mfa ? { twoStep: true } : undefined, ip: meta.ip });
    return this.issue(updated, meta, undefined, mfa);
  }

  /** Wrong password or wrong code: both count towards locking the account. */
  private async failedAttempt(user: User, reason: 'bad_password' | 'bad_code', meta: Meta) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
    });
    await this.audit.record({
      actorId: user.id, action: lock ? 'auth.account_locked' : 'auth.login_failed', targetType: 'user', targetId: user.id,
      schoolId: user.schoolId, meta: { reason, attempt: failed }, ip: meta.ip,
    });
  }

  /**
   * Signs a short-lived access token and stores a new refresh token. `mfa` records that this session passed
   * two-step sign-in. Someone whose role requires two-step sign-in but whose session did not pass it can only set
   * it up (`tsp`, two-step pending).
   */
  async issue(user: User & { school?: any }, meta: Meta, replacing?: string, mfa = false) {
    const tsp = twoStepRequired(user.role) && !mfa;
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role, sid: user.schoolId, lga: user.lga, mcp: user.mustChangePassword, mfa, tsp });
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshDays() * 86_400_000);
    const row = await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: sha256(refreshToken), expiresAt, ip: meta.ip, userAgent: meta.userAgent, mfa },
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
    // A session that did not pass two-step sign-in cannot carry on once the account has it switched on.
    if (this.twoStep.enabled(u) && !row.mfa) throw new UnauthorizedException('Please sign in again with your authenticator code.');
    return this.issue(u, meta, row.revokedAt ? undefined : row.id, row.mfa);
  }

  async logout(token: string | undefined) {
    if (!token) return;
    await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
  }

  revokeAll(userId: string) {
    return this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async changePassword(userId: string, current: string, next: string, meta: Meta, mfa = false) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, current))) throw new BadRequestException('Your current password is incorrect.');
    const problem = passwordProblem(next, user);
    if (problem) throw new BadRequestException(problem);
    if (await isBreachedPassword(next)) {
      throw new BadRequestException('That password has appeared in a data breach elsewhere, so attackers try it first. Choose a different one.');
    }
    if (await verifyPassword(user.passwordHash, next)) throw new BadRequestException('Choose a password different from your current one.');

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(next), mustChangePassword: false, passwordChangedAt: new Date() },
      include: { school: true },
    });
    await this.revokeAll(userId);
    await this.audit.record({ actorId: userId, action: 'auth.password_changed', targetType: 'user', targetId: userId, schoolId: user.schoolId, ip: meta.ip });
    return this.issue(updated, meta, undefined, mfa);
  }

  async me(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { school: true } });
    return userView(u);
  }

  // ---- Two-step sign-in management (the signed-in person's own account) ----

  twoStepStatus(userId: string) {
    return this.twoStep.status(userId);
  }

  twoStepBegin(userId: string) {
    return this.twoStep.begin(userId);
  }

  /** Switches two-step sign-in on, ends every other session and returns a fresh session plus recovery codes. */
  async twoStepConfirm(userId: string, code: string, meta: Meta) {
    const recoveryCodes = await this.twoStep.confirm(userId, code);
    await this.revokeAll(userId);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { school: true } });
    await this.audit.record({ actorId: userId, action: 'auth.two_step_enabled', targetType: 'user', targetId: userId, schoolId: u.schoolId, ip: meta.ip });
    return { ...(await this.issue(u, meta, undefined, true)), recoveryCodes };
  }

  async twoStepDisable(userId: string, password: string, code: string, meta: Meta) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { school: true } });
    this.twoStep.assertMayTurnOff(u);
    if (!this.twoStep.enabled(u)) throw new BadRequestException('Two-step sign-in is not on.');
    if (!(await verifyPassword(u.passwordHash, password))) throw new BadRequestException('Your password is incorrect.');
    if (!(await this.twoStep.check(u, code))) throw new BadRequestException(BAD_CODE);
    await this.twoStep.clear(userId);
    await this.revokeAll(userId);
    await this.audit.record({ actorId: userId, action: 'auth.two_step_disabled', targetType: 'user', targetId: userId, schoolId: u.schoolId, ip: meta.ip });
    return this.issue(u, meta);
  }

  async twoStepRecoveryCodes(userId: string, code: string, meta: Meta) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!this.twoStep.enabled(u)) throw new BadRequestException('Two-step sign-in is not on.');
    if ((await this.twoStep.check(u, code)) !== 'totp') throw new BadRequestException('Enter the current code from your authenticator app.');
    const recoveryCodes = await this.twoStep.newRecoveryCodes(userId);
    await this.audit.record({ actorId: userId, action: 'auth.recovery_codes_replaced', targetType: 'user', targetId: userId, schoolId: u.schoolId, ip: meta.ip });
    return { recoveryCodes };
  }
}
