import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { normaliseEmail, normalisePhone } from '../common/identity';
import { generateTempPassword, hashPassword } from '../common/password';
import { LGA_NAMES } from '../common/lgas';
import { CAN_MANAGE, MINISTRY_ROLES, SCHOOL_ROLES, STATE_ROLES } from '../common/roles';
import { twoStepRequired } from '../common/two-step-policy';
import { userView } from '../common/user-view';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto, ListUsersQuery, NewAccountDto, UpdateUserDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Checks that `actor` may manage an account with this role in this school, and returns the school to use. */
  private scopeFor(actor: AuthUser, role: Role, schoolId: string | null | undefined): string | null {
    if (!CAN_MANAGE[actor.role].includes(role)) throw new ForbiddenException('You cannot manage this type of account.');
    if (STATE_ROLES.includes(role)) return null;
    if (actor.role === Role.SCHOOL_ADMIN) {
      if (schoolId && schoolId !== actor.schoolId) throw new ForbiddenException('You can only manage accounts in your own school.');
      return actor.schoolId;
    }
    if (!schoolId) throw new BadRequestException('Choose the school this account belongs to.');
    return schoolId;
  }

  /** The LGA an account oversees: required for LGA officers, optional for inspectors, not allowed for others. */
  private lgaFor(role: Role, lga: string | null | undefined): string | null {
    const value = lga?.trim() || null;
    if (role === Role.LGA_OFFICER && !value) throw new BadRequestException('Choose the LGA this officer oversees.');
    if (value && role !== Role.LGA_OFFICER && role !== Role.INSPECTOR) throw new BadRequestException('Only LGA officers and inspectors oversee an LGA.');
    if (value) {
      const match = LGA_NAMES.find((n) => n.toLowerCase() === value.toLowerCase());
      if (!match) throw new BadRequestException(`${value} is not an Osun LGA.`);
      return match;
    }
    return null;
  }

  /** Validates and normalises the email and phone. At least one is required. */
  private contact(email?: string, phone?: string) {
    const e = email ? normaliseEmail(email) : null;
    let p: string | null = null;
    if (phone) {
      p = normalisePhone(phone);
      if (!p) throw new BadRequestException('Enter a valid Nigerian phone number, for example 0803 123 4567.');
    }
    return { email: e, phone: p };
  }

  private uniqueError(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const field = String((e.meta?.target as string[] | undefined)?.[0] ?? 'detail');
      throw new ConflictException(`Another account already uses this ${field === 'phone' ? 'phone number' : field === 'email' ? 'email address' : field}.`);
    }
    throw e;
  }

  /** Creates an account with a temporary password. Used by users and schools. */
  async createInTx(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    dto: NewAccountDto,
    role: Role,
    schoolId: string | null,
    ip: string | null,
    lga: string | null = null,
  ) {
    const { email, phone } = this.contact(dto.email, dto.phone);
    if (!email && !phone) throw new BadRequestException('Give an email address or a phone number so the person can sign in.');
    const tempPassword = generateTempPassword();
    let user;
    try {
      user = await tx.user.create({
        data: {
          fullName: dto.fullName, email, phone, role, schoolId, lga,
          passwordHash: await hashPassword(tempPassword), mustChangePassword: true, createdById: actor.id,
        },
        include: { school: true },
      });
    } catch (e) {
      this.uniqueError(e);
    }
    await this.audit.record(
      { actorId: actor.id, action: 'user.created', targetType: 'user', targetId: user.id, schoolId, meta: { role, ...(lga ? { lga } : {}) }, ip },
      tx,
    );
    return { user: userView(user), tempPassword };
  }

  async create(actor: AuthUser, dto: CreateUserDto, ip: string | null) {
    const schoolId = this.scopeFor(actor, dto.role, dto.schoolId);
    const lga = this.lgaFor(dto.role, dto.lga);
    if (schoolId) {
      const school = await this.prisma.school.findUnique({ where: { id: schoolId } });
      if (!school) throw new BadRequestException('That school does not exist.');
      if (!school.isActive) throw new BadRequestException('That school is deactivated.');
    }
    return this.prisma.$transaction((tx) => this.createInTx(tx, actor, dto, dto.role, schoolId, ip, lga));
  }

  /** Which accounts the actor can see. */
  private visibleWhere(actor: AuthUser): Prisma.UserWhereInput {
    if (MINISTRY_ROLES.includes(actor.role)) return {};
    if (actor.role === Role.SCHOOL_ADMIN) return { schoolId: actor.schoolId, role: { in: SCHOOL_ROLES } };
    throw new ForbiddenException('You do not have access to this.');
  }

  async list(actor: AuthUser, q: ListUsersQuery) {
    const where: Prisma.UserWhereInput = { AND: [this.visibleWhere(actor)] };
    const and = where.AND as Prisma.UserWhereInput[];
    if (q.role) and.push({ role: q.role });
    if (q.schoolId) and.push({ schoolId: q.schoolId });
    if (q.q) {
      const s = q.q.trim();
      const phone = normalisePhone(s);
      and.push({
        OR: [
          { fullName: { contains: s, mode: 'insensitive' } },
          { email: { contains: s.toLowerCase() } },
          ...(phone ? [{ phone }] : [{ phone: { contains: s.replace(/\D/g, '') || s } }]),
        ],
      });
    }
    const users = await this.prisma.user.findMany({ where, include: { school: true }, orderBy: [{ role: 'asc' }, { fullName: 'asc' }], take: 500 });
    return users.map(userView);
  }

  private async findManageable(actor: AuthUser, id: string) {
    const target = await this.prisma.user.findUnique({ where: { id }, include: { school: true } });
    if (!target) throw new NotFoundException('Account not found.');
    this.scopeFor(actor, target.role, target.schoolId);
    return target;
  }

  async get(actor: AuthUser, id: string) {
    const where = { AND: [this.visibleWhere(actor), { id }] };
    const u = await this.prisma.user.findFirst({ where, include: { school: true } });
    if (!u) throw new NotFoundException('Account not found.');
    return userView(u);
  }

  async update(actor: AuthUser, id: string, dto: UpdateUserDto, ip: string | null) {
    const target = await this.findManageable(actor, id);
    if (dto.isActive === false && target.id === actor.id) throw new BadRequestException('You cannot deactivate your own account.');
    const data: Prisma.UserUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName;
    if (dto.email !== undefined || dto.phone !== undefined) {
      const email = dto.email === undefined ? target.email : dto.email || null;
      const phone = dto.phone === undefined ? target.phone : dto.phone || null;
      const c = this.contact(email ?? undefined, phone ?? undefined);
      if (!c.email && !c.phone) throw new BadRequestException('An account needs an email address or a phone number.');
      data.email = c.email;
      data.phone = c.phone;
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.lga !== undefined) {
      if (target.role !== Role.LGA_OFFICER && target.role !== Role.INSPECTOR) throw new BadRequestException('Only LGA officers and inspectors oversee an LGA.');
      data.lga = this.lgaFor(target.role, dto.lga);
    }
    let u;
    try {
      u = await this.prisma.user.update({ where: { id }, data, include: { school: true } });
    } catch (e) {
      this.uniqueError(e);
    }
    // The LGA travels in the access token, so a change signs the person out everywhere to take effect at once.
    if (dto.isActive === false || (dto.lga !== undefined && u!.lga !== target.lga)) await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    const action = dto.isActive === false ? 'user.deactivated' : dto.isActive === true && !target.isActive ? 'user.reactivated' : 'user.updated';
    await this.audit.record({ actorId: actor.id, action, targetType: 'user', targetId: id, schoolId: target.schoolId, ip });
    return userView(u);
  }

  /** Issues a new temporary password, unlocks the account and signs it out everywhere. */
  async resetPassword(actor: AuthUser, id: string, ip: string | null) {
    const target = await this.findManageable(actor, id);
    const tempPassword = generateTempPassword();
    const u = await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await hashPassword(tempPassword), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
      include: { school: true },
    });
    await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({ actorId: actor.id, action: 'user.password_reset', targetType: 'user', targetId: id, schoolId: target.schoolId, ip });
    return { user: userView(u), tempPassword };
  }

  /**
   * Turns off someone's two-step sign-in, for when they lose their phone and their recovery codes. They are signed
   * out everywhere; Ministry accounts must set it up again at their next sign-in. Only a Ministry administrator may
   * reset a Ministry account, and nobody can reset their own.
   */
  async resetTwoStep(actor: AuthUser, id: string, ip: string | null) {
    const target = await this.findManageable(actor, id);
    if (target.id === actor.id) throw new BadRequestException('Ask another administrator to reset your own two-step sign-in.');
    if (twoStepRequired(target.role) && actor.role !== Role.MINISTRY_ADMIN) {
      throw new ForbiddenException('Only a Ministry administrator can reset two-step sign-in for a Ministry account.');
    }
    if (!target.totpEnabledAt) throw new BadRequestException('Two-step sign-in is not on for this account.');
    const [u] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null }, include: { school: true } }),
      this.prisma.recoveryCode.deleteMany({ where: { userId: id } }),
      this.prisma.mfaChallenge.deleteMany({ where: { userId: id } }),
      this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.record({ actorId: actor.id, action: 'user.two_step_reset', targetType: 'user', targetId: id, schoolId: target.schoolId, ip });
    return userView(u);
  }
}
