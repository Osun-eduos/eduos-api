import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { createHash, randomInt } from 'crypto';
import { toString as qrSvg } from 'qrcode';
import { twoStepRequired } from '../../common/two-step-policy';
import { PrismaService } from '../../prisma/prisma.service';
import { loadMfaKey, open, seal } from './secret-box';
import { newTotpSecret, otpauthUrl, verifyTotp } from './totp';

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const normaliseRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export type CodeKind = 'totp' | 'recovery';

/** Authenticator-app set-up, codes and recovery codes. Sign-in itself is in AuthService. */
@Injectable()
export class TwoStepService {
  private readonly key: Buffer;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.key = loadMfaKey(config.get<string>('MFA_ENCRYPTION_KEY'));
  }

  enabled(u: Pick<User, 'totpEnabledAt' | 'totpSecret'>) {
    return !!(u.totpEnabledAt && u.totpSecret);
  }

  async status(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const recoveryCodesLeft = this.enabled(u) ? await this.prisma.recoveryCode.count({ where: { userId, usedAt: null } }) : 0;
    return { enabled: this.enabled(u), required: twoStepRequired(u.role), enabledAt: u.totpEnabledAt, recoveryCodesLeft };
  }

  /** Starts set-up: a new secret, kept as pending until the person proves their app has it. */
  async begin(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (this.enabled(u)) throw new BadRequestException('Two-step sign-in is already on. Turn it off first to move it to a new phone.');
    const secret = newTotpSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { totpPendingSecret: seal(this.key, secret) } });
    const url = otpauthUrl(secret, u.email ?? u.phone ?? u.fullName);
    return { secret, otpauthUrl: url, qrSvg: await qrSvg(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  }

  /** Confirms set-up with a code from the app. Returns one-time recovery codes, shown once. */
  async confirm(userId: string, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (this.enabled(u)) throw new BadRequestException('Two-step sign-in is already on.');
    if (!u.totpPendingSecret) throw new BadRequestException('Start set-up first.');
    const step = verifyTotp(open(this.key, u.totpPendingSecret), code);
    if (step === null) throw new BadRequestException('That code is not right. Check the time on your phone is set automatically, and use the newest code.');
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: u.totpPendingSecret, totpPendingSecret: null, totpEnabledAt: new Date(), totpLastStep: step },
    });
    return this.newRecoveryCodes(userId);
  }

  /** Checks an authenticator code, or else a recovery code (each recovery code works once). */
  async check(u: User, code: string): Promise<CodeKind | null> {
    if (!this.enabled(u)) return null;
    const step = verifyTotp(open(this.key, u.totpSecret!), code, Date.now(), u.totpLastStep);
    if (step !== null) {
      // Only move forward, so two requests racing with the same code cannot both succeed.
      const { count } = await this.prisma.user.updateMany({
        where: { id: u.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
        data: { totpLastStep: step },
      });
      return count === 1 ? 'totp' : null;
    }
    const normalised = normaliseRecovery(code);
    if (normalised.length !== 10) return null;
    const { count } = await this.prisma.recoveryCode.updateMany({
      where: { userId: u.id, codeHash: sha256(normalised), usedAt: null },
      data: { usedAt: new Date() },
    });
    return count === 1 ? 'recovery' : null;
  }

  async newRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      let s = '';
      for (let i = 0; i < 10; i++) s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
      return s;
    });
    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: sha256(c) })) }),
    ]);
    return codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`);
  }

  /** Turns two-step sign-in off for someone: their own choice (where allowed) or an administrator's reset. */
  async clear(userId: string) {
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null } }),
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.mfaChallenge.deleteMany({ where: { userId } }),
    ]);
  }

  assertMayTurnOff(u: Pick<User, 'role'>) {
    if (twoStepRequired(u.role)) throw new ForbiddenException('Two-step sign-in is required for Ministry accounts and cannot be turned off.');
  }
}
