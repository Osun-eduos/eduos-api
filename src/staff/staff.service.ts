import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PostingStatus, Prisma, Role, StaffStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { nextValue } from '../common/counter';
import { isoDate, parseDate, today } from '../common/dates';
import { normaliseEmail, normalisePhone } from '../common/identity';
import { SUBJECTS } from '../common/results';
import { isOversight, schoolsInScope, seesLga } from '../common/scope';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStaffDto, ListStaffQuery, PostDto, PostingRequestDto, QualificationDto, TrainingDto, UpdateStaffDto } from './dto';

type Tx = Prisma.TransactionClient;

const SUBJECT_CODES = new Set(SUBJECTS.map((s) => s.code));
const schoolSelect = { id: true, name: true, code: true, lga: true } as const;
const listInclude = { currentSchool: { select: schoolSelect }, user: { select: { id: true, fullName: true, role: true } } } satisfies Prisma.StaffInclude;
type ListRow = Prisma.StaffGetPayload<{ include: typeof listInclude }>;

const fullName = (s: { surname: string; firstName: string; middleName: string | null }) => [s.surname, s.firstName, s.middleName].filter(Boolean).join(' ');

/** State-wide staff number, e.g. OSN-ST-000123. */
async function nextStaffNumber(tx: Tx) {
  return `OSN-ST-${String(await nextValue(tx, 'staff')).padStart(6, '0')}`;
}

/** Whole years between two dates. */
function yearsBetween(from: Date, to: Date) {
  let y = to.getUTCFullYear() - from.getUTCFullYear();
  if (to.getUTCMonth() < from.getUTCMonth() || (to.getUTCMonth() === from.getUTCMonth() && to.getUTCDate() < from.getUTCDate())) y--;
  return y;
}

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private summary(s: ListRow) {
    return {
      id: s.id, staffNumber: s.staffNumber, fullName: fullName(s), sex: s.sex, category: s.category, rank: s.rank,
      gradeLevel: s.gradeLevel, step: s.step, status: s.status, phone: s.phone, email: s.email, subjects: s.subjects,
      school: s.currentSchool, account: s.user, trcnNumber: s.trcnNumber,
      yearsOfService: s.firstAppointment ? yearsBetween(s.firstAppointment, today()) : null,
    };
  }

  /** Staff the actor may see: their own school's, or the schools in their area for oversight roles. */
  private visible(actor: AuthUser): Prisma.StaffWhereInput {
    if (actor.role === Role.SCHOOL_ADMIN) return { currentSchoolId: actor.schoolId! };
    if (isOversight(actor)) return actor.lga ? { currentSchool: schoolsInScope(actor) } : {};
    throw new ForbiddenException('You do not have access to this.');
  }

  /** Loads a staff record the actor may see; with `edit`, one they may change. */
  private async load(actor: AuthUser, id: string, edit = false) {
    const s = await this.prisma.staff.findUnique({ where: { id }, include: { currentSchool: { select: schoolSelect } } });
    if (!s) throw new NotFoundException('Staff record not found.');
    const own = actor.role === Role.SCHOOL_ADMIN && s.currentSchoolId === actor.schoolId;
    // A state-wide oversight user also sees staff who have left (no current school).
    const sees = own || (isOversight(actor) && (s.currentSchool ? seesLga(actor, s.currentSchool.lga) : !actor.lga));
    if (!sees) throw new NotFoundException('Staff record not found.');
    if (edit && !own && actor.role !== Role.MINISTRY_ADMIN) throw new ForbiddenException('Only the school or the Ministry can change staff records.');
    return s;
  }

  private checkFields(dto: { subjects?: string[]; phone?: string; email?: string; dateOfBirth?: string; firstAppointment?: string }) {
    const bad = (dto.subjects ?? []).filter((c) => !SUBJECT_CODES.has(c));
    if (bad.length) throw new BadRequestException(`Unknown subject code: ${bad.join(', ')}.`);
    let phone: string | null | undefined;
    if (dto.phone !== undefined) {
      phone = dto.phone ? normalisePhone(dto.phone) : null;
      if (dto.phone && !phone) throw new BadRequestException('Enter a valid Nigerian phone number, for example 0803 123 4567.');
    }
    const dob = dto.dateOfBirth ? parseDate(dto.dateOfBirth, 'Date of birth') : undefined;
    if (dob) {
      const age = yearsBetween(dob, today());
      if (age < 16 || age > 75) throw new BadRequestException('Check the date of birth: the person would be under 16 or over 75.');
    }
    const appointed = dto.firstAppointment ? parseDate(dto.firstAppointment, 'First appointment') : undefined;
    if (appointed && appointed > today()) throw new BadRequestException('The first appointment date is in the future.');
    if (dob && appointed && yearsBetween(dob, appointed) < 16) throw new BadRequestException('The first appointment is before the person turned 16.');
    return {
      ...(phone !== undefined ? { phone } : {}),
      ...(dto.email !== undefined ? { email: dto.email ? normaliseEmail(dto.email) : null } : {}),
      ...(dob ? { dateOfBirth: dob } : {}),
      ...(appointed ? { firstAppointment: appointed } : {}),
      ...(dto.subjects ? { subjects: [...new Set(dto.subjects)] } : {}),
    };
  }

  async list(actor: AuthUser, q: ListStaffQuery) {
    const where: Prisma.StaffWhereInput = { AND: [this.visible(actor)] };
    const and = where.AND as Prisma.StaffWhereInput[];
    if (q.schoolId) and.push({ currentSchoolId: q.schoolId });
    if (q.category) and.push({ category: q.category });
    and.push(q.status ? { status: q.status } : { status: { in: [StaffStatus.ACTIVE, StaffStatus.ON_LEAVE] } });
    if (q.q) {
      const words = q.q.split(/\s+/).filter(Boolean);
      and.push(
        ...words.map((w) => ({
          OR: [
            { surname: { contains: w, mode: Prisma.QueryMode.insensitive } },
            { firstName: { contains: w, mode: Prisma.QueryMode.insensitive } },
            { middleName: { contains: w, mode: Prisma.QueryMode.insensitive } },
            { staffNumber: { contains: w, mode: Prisma.QueryMode.insensitive } },
            { trcnNumber: { contains: w, mode: Prisma.QueryMode.insensitive } },
          ],
        })),
      );
    }
    const rows = await this.prisma.staff.findMany({ where, include: listInclude, orderBy: [{ surname: 'asc' }, { firstName: 'asc' }], take: 500 });
    return rows.map((r) => this.summary(r));
  }

  async get(actor: AuthUser, id: string) {
    await this.load(actor, id);
    return this.record(id);
  }

  private async record(id: string) {
    const s = await this.prisma.staff.findUniqueOrThrow({
      where: { id },
      include: {
        ...listInclude,
        qualifications: { orderBy: [{ year: 'desc' }, { createdAt: 'desc' }] },
        trainings: { orderBy: { startDate: 'desc' } },
        postings: { include: { school: { select: schoolSelect } }, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }] },
        postingRequests: { orderBy: { requestedAt: 'desc' }, take: 10 },
      },
    });
    const schoolIds = [...new Set(s.postingRequests.flatMap((r) => [r.toSchoolId, r.fromSchoolId]).filter(Boolean))] as string[];
    const schools = new Map((await this.prisma.school.findMany({ where: { id: { in: schoolIds } }, select: schoolSelect })).map((x) => [x.id, x]));
    return {
      ...this.summary(s),
      surname: s.surname, firstName: s.firstName, middleName: s.middleName,
      dateOfBirth: isoDate(s.dateOfBirth), firstAppointment: isoDate(s.firstAppointment),
      age: s.dateOfBirth ? yearsBetween(s.dateOfBirth, today()) : null,
      qualifications: s.qualifications.map((q) => ({ id: q.id, kind: q.kind, course: q.course, institution: q.institution, year: q.year })),
      trainings: s.trainings.map((t) => ({ id: t.id, title: t.title, provider: t.provider, startDate: isoDate(t.startDate), endDate: isoDate(t.endDate), hours: t.hours })),
      postings: s.postings.map((p) => ({ id: p.id, school: p.school, startDate: isoDate(p.startDate), endDate: isoDate(p.endDate), reason: p.reason })),
      requests: s.postingRequests.map((r) => ({
        id: r.id, status: r.status, reason: r.reason, note: r.note, effectiveDate: isoDate(r.effectiveDate), requestedAt: r.requestedAt,
        from: r.fromSchoolId ? schools.get(r.fromSchoolId) ?? null : null, to: schools.get(r.toSchoolId) ?? null,
      })),
    };
  }

  async create(actor: AuthUser, dto: CreateStaffDto, ip: string | null) {
    const schoolId = actor.role === Role.SCHOOL_ADMIN ? actor.schoolId! : dto.schoolId;
    if (!schoolId) throw new BadRequestException('Choose the school.');
    const school = await this.prisma.school.findUnique({ where: { id: schoolId } });
    if (!school || !school.isActive) throw new BadRequestException('Choose an active school.');
    const extra = this.checkFields(dto);
    const postedOn = dto.postedOn ? parseDate(dto.postedOn, 'Posting date') : today();
    if (postedOn > today()) throw new BadRequestException('The posting date is in the future.');
    const id = await this.prisma.$transaction(async (tx) => {
      const s = await tx.staff.create({
        data: {
          staffNumber: await nextStaffNumber(tx), surname: dto.surname, firstName: dto.firstName, middleName: dto.middleName, sex: dto.sex,
          category: dto.category, rank: dto.rank, gradeLevel: dto.gradeLevel, step: dto.step, trcnNumber: dto.trcnNumber,
          subjects: [], ...extra, currentSchoolId: schoolId, createdById: actor.id,
        },
      });
      await tx.posting.create({ data: { staffId: s.id, schoolId, startDate: postedOn, reason: 'Added to the registry', createdById: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'staff.created', targetType: 'staff', targetId: s.id, schoolId, meta: { staffNumber: s.staffNumber }, ip }, tx);
      return s.id;
    });
    return this.record(id);
  }

  async update(actor: AuthUser, id: string, dto: UpdateStaffDto, ip: string | null) {
    const s = await this.load(actor, id, true);
    const extra = this.checkFields(dto);
    const leaving = (dto.status === StaffStatus.LEFT || dto.status === StaffStatus.RETIRED) && s.currentSchoolId;
    await this.prisma.$transaction(async (tx) => {
      await tx.staff.update({
        where: { id },
        data: {
          surname: dto.surname, firstName: dto.firstName, middleName: dto.middleName, sex: dto.sex, category: dto.category,
          rank: dto.rank, gradeLevel: dto.gradeLevel, step: dto.step, trcnNumber: dto.trcnNumber, status: dto.status, ...extra,
          ...(leaving ? { currentSchoolId: null } : {}),
        },
      });
      // Someone who leaves or retires no longer works at the school.
      if (leaving) await tx.posting.updateMany({ where: { staffId: id, endDate: null }, data: { endDate: today(), reason: undefined } });
      await this.audit.record({ actorId: actor.id, action: 'staff.updated', targetType: 'staff', targetId: id, schoolId: s.currentSchoolId, meta: { fields: Object.keys(dto) }, ip }, tx);
    });
    return this.record(id);
  }

  async addQualification(actor: AuthUser, id: string, dto: QualificationDto, ip: string | null) {
    const s = await this.load(actor, id, true);
    if (dto.year && dto.year > today().getUTCFullYear()) throw new BadRequestException('The year is in the future.');
    await this.prisma.qualification.create({ data: { staffId: id, kind: dto.kind, course: dto.course, institution: dto.institution, year: dto.year } });
    await this.audit.record({ actorId: actor.id, action: 'staff.qualification_added', targetType: 'staff', targetId: id, schoolId: s.currentSchoolId, meta: { kind: dto.kind }, ip });
    return this.record(id);
  }

  async removeQualification(actor: AuthUser, id: string, qid: string) {
    await this.load(actor, id, true);
    const { count } = await this.prisma.qualification.deleteMany({ where: { id: qid, staffId: id } });
    if (!count) throw new NotFoundException('Qualification not found.');
    return this.record(id);
  }

  /** Schools record training for their own staff; the Ministry records it for anyone (it runs most training). */
  async addTraining(actor: AuthUser, id: string, dto: TrainingDto, ip: string | null) {
    const s = await this.load(actor, id, true);
    const start = parseDate(dto.startDate, 'Start date');
    const end = dto.endDate ? parseDate(dto.endDate, 'End date') : null;
    if (end && end < start) throw new BadRequestException('The training must end on or after the day it starts.');
    if (start > today()) throw new BadRequestException('Record training once it has started.');
    await this.prisma.training.create({ data: { staffId: id, title: dto.title, provider: dto.provider, startDate: start, endDate: end, hours: dto.hours, createdById: actor.id } });
    await this.audit.record({ actorId: actor.id, action: 'staff.training_added', targetType: 'staff', targetId: id, schoolId: s.currentSchoolId, meta: { title: dto.title }, ip });
    return this.record(id);
  }

  async removeTraining(actor: AuthUser, id: string, tid: string) {
    await this.load(actor, id, true);
    const { count } = await this.prisma.training.deleteMany({ where: { id: tid, staffId: id } });
    if (!count) throw new NotFoundException('Training record not found.');
    return this.record(id);
  }

  /** Links the record to a teacher or school administrator account at the same school, or unlinks it. */
  async linkAccount(actor: AuthUser, id: string, userId: string | null, ip: string | null) {
    const s = await this.load(actor, id, true);
    if (userId) {
      const u = await this.prisma.user.findUnique({ where: { id: userId }, include: { staffRecord: { select: { id: true } } } });
      if (!u || u.schoolId !== s.currentSchoolId || (u.role !== Role.TEACHER && u.role !== Role.SCHOOL_ADMIN)) {
        throw new BadRequestException('Choose a teacher or school administrator account at the same school.');
      }
      if (u.staffRecord && u.staffRecord.id !== id) throw new ConflictException('That account is already linked to another staff record.');
    }
    await this.prisma.staff.update({ where: { id }, data: { userId } });
    await this.audit.record({ actorId: actor.id, action: userId ? 'staff.account_linked' : 'staff.account_unlinked', targetType: 'staff', targetId: id, schoolId: s.currentSchoolId, meta: { userId }, ip });
    return this.record(id);
  }

  /**
   * Moves staff to another school: closes the current posting and opens a new one. A linked teacher or
   * administrator account moves too; it is signed out and loses its class and subject assignments at the old school.
   */
  private async move(tx: Tx, actor: AuthUser, staffId: string, toSchoolId: string, start: Date, reason: string | undefined, ip: string | null) {
    const s = await tx.staff.findUniqueOrThrow({ where: { id: staffId }, include: { user: true } });
    if (s.currentSchoolId === toSchoolId) throw new BadRequestException('They already work at that school.');
    if (s.status === StaffStatus.LEFT || s.status === StaffStatus.RETIRED) throw new BadRequestException('Only current staff can be posted.');
    const to = await tx.school.findUnique({ where: { id: toSchoolId } });
    if (!to || !to.isActive) throw new BadRequestException('Choose an active school.');
    const open = await tx.posting.findFirst({ where: { staffId, endDate: null } });
    if (open && start < open.startDate) throw new BadRequestException('The new posting must start after the current one began.');
    await tx.posting.updateMany({ where: { staffId, endDate: null }, data: { endDate: start } });
    await tx.posting.create({ data: { staffId, schoolId: toSchoolId, startDate: start, reason, createdById: actor.id } });
    await tx.staff.update({ where: { id: staffId }, data: { currentSchoolId: toSchoolId } });
    const from = s.currentSchoolId;
    if (s.user && from && (s.user.role === Role.TEACHER || s.user.role === Role.SCHOOL_ADMIN)) {
      await tx.classArm.updateMany({ where: { schoolId: from, classTeacherId: s.user.id }, data: { classTeacherId: null } });
      await tx.classSubject.updateMany({ where: { teacherId: s.user.id, classArm: { schoolId: from } }, data: { teacherId: null } });
      await tx.user.update({ where: { id: s.user.id }, data: { schoolId: toSchoolId } });
      await tx.refreshToken.updateMany({ where: { userId: s.user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    for (const schoolId of [from, toSchoolId].filter(Boolean) as string[]) {
      await this.audit.record({ actorId: actor.id, action: 'staff.posted', targetType: 'staff', targetId: staffId, schoolId, meta: { from, to: toSchoolId, start: isoDate(start) }, ip }, tx);
    }
  }

  /** The Ministry posts someone directly. */
  async post(actor: AuthUser, id: string, dto: PostDto, ip: string | null) {
    await this.load(actor, id, true);
    const start = dto.startDate ? parseDate(dto.startDate, 'Start date') : today();
    await this.prisma.$transaction(async (tx) => {
      await this.move(tx, actor, id, dto.schoolId, start, dto.reason ?? 'Posted by the Ministry', ip);
      await tx.postingRequest.updateMany({ where: { staffId: id, status: PostingStatus.REQUESTED }, data: { status: PostingStatus.CANCELLED, note: 'Overtaken by a Ministry posting.', decidedById: actor.id, decidedAt: new Date() } });
    });
    return this.record(id);
  }

  // ---------- Transfer requests ----------

  private async requestView(rows: Prisma.PostingRequestGetPayload<{ include: { staff: { include: typeof listInclude } } }>[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.toSchoolId, r.fromSchoolId]).filter(Boolean))] as string[];
    const schools = new Map((await this.prisma.school.findMany({ where: { id: { in: ids } }, select: schoolSelect })).map((x) => [x.id, x]));
    const users = [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter(Boolean))] as string[];
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: users } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      id: r.id, status: r.status, reason: r.reason, note: r.note, effectiveDate: isoDate(r.effectiveDate), requestedAt: r.requestedAt, decidedAt: r.decidedAt,
      requestedBy: names.get(r.requestedById) ?? null, decidedBy: r.decidedById ? names.get(r.decidedById) ?? null : null,
      from: r.fromSchoolId ? schools.get(r.fromSchoolId) ?? null : null, to: schools.get(r.toSchoolId) ?? null,
      staff: this.summary(r.staff),
    }));
  }

  async listRequests(actor: AuthUser, status?: PostingStatus) {
    let where: Prisma.PostingRequestWhereInput;
    if (actor.role === Role.SCHOOL_ADMIN) where = { OR: [{ fromSchoolId: actor.schoolId! }, { toSchoolId: actor.schoolId! }] };
    else if (isOversight(actor)) {
      if (actor.lga) {
        const inArea = (await this.prisma.school.findMany({ where: { lga: actor.lga }, select: { id: true } })).map((s) => s.id);
        where = { OR: [{ fromSchoolId: { in: inArea } }, { toSchoolId: { in: inArea } }] };
      } else where = {};
    } else throw new ForbiddenException('You do not have access to this.');
    if (status) where = { AND: [where, { status }] };
    const rows = await this.prisma.postingRequest.findMany({ where, include: { staff: { include: listInclude } }, orderBy: { requestedAt: 'desc' }, take: 300 });
    return this.requestView(rows);
  }

  /** A school asks the Ministry to move one of its staff to another school. */
  async request(actor: AuthUser, dto: PostingRequestDto, ip: string | null) {
    const s = await this.load(actor, dto.staffId, true);
    if (actor.role !== Role.SCHOOL_ADMIN) throw new ForbiddenException('The Ministry posts staff directly.');
    if (s.status !== StaffStatus.ACTIVE && s.status !== StaffStatus.ON_LEAVE) throw new BadRequestException('Only current staff can be transferred.');
    if (dto.toSchoolId === s.currentSchoolId) throw new BadRequestException('Choose a different school.');
    const to = await this.prisma.school.findUnique({ where: { id: dto.toSchoolId } });
    if (!to || !to.isActive) throw new BadRequestException('Choose an active school.');
    const effective = dto.effectiveDate ? parseDate(dto.effectiveDate, 'Effective date') : today();
    if (await this.prisma.postingRequest.count({ where: { staffId: s.id, status: PostingStatus.REQUESTED } })) throw new ConflictException('A transfer for this person is already waiting for the Ministry.');
    const r = await this.prisma.postingRequest.create({
      data: { staffId: s.id, fromSchoolId: s.currentSchoolId, toSchoolId: to.id, reason: dto.reason, effectiveDate: effective, requestedById: actor.id },
      include: { staff: { include: listInclude } },
    });
    await this.audit.record({ actorId: actor.id, action: 'staff.transfer_requested', targetType: 'staff', targetId: s.id, schoolId: actor.schoolId, meta: { to: to.name }, ip });
    return (await this.requestView([r]))[0];
  }

  private async pending(id: string) {
    const r = await this.prisma.postingRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Transfer request not found.');
    if (r.status !== PostingStatus.REQUESTED) throw new BadRequestException('This request has already been decided.');
    return r;
  }

  async decide(actor: AuthUser, id: string, approve: boolean, note: string | undefined, ip: string | null) {
    const r = await this.pending(id);
    await this.prisma.$transaction(async (tx) => {
      if (approve) {
        const s = await tx.staff.findUniqueOrThrow({ where: { id: r.staffId } });
        if (s.currentSchoolId !== r.fromSchoolId) throw new ConflictException('They are no longer at the school that asked. The request cannot go ahead.');
        const start = r.effectiveDate > today() ? r.effectiveDate : today();
        await this.move(tx, actor, r.staffId, r.toSchoolId, start, r.reason, ip);
      }
      await tx.postingRequest.update({ where: { id }, data: { status: approve ? PostingStatus.APPROVED : PostingStatus.REJECTED, note, decidedById: actor.id, decidedAt: new Date() } });
      await this.audit.record({ actorId: actor.id, action: approve ? 'staff.transfer_approved' : 'staff.transfer_rejected', targetType: 'staff', targetId: r.staffId, schoolId: r.fromSchoolId, ip }, tx);
    });
    const row = await this.prisma.postingRequest.findUniqueOrThrow({ where: { id }, include: { staff: { include: listInclude } } });
    return (await this.requestView([row]))[0];
  }

  async cancel(actor: AuthUser, id: string, ip: string | null) {
    const r = await this.pending(id);
    if (r.fromSchoolId !== actor.schoolId) throw new NotFoundException('Transfer request not found.');
    const row = await this.prisma.postingRequest.update({
      where: { id }, data: { status: PostingStatus.CANCELLED, decidedById: actor.id, decidedAt: new Date() }, include: { staff: { include: listInclude } },
    });
    await this.audit.record({ actorId: actor.id, action: 'staff.transfer_cancelled', targetType: 'staff', targetId: r.staffId, schoolId: actor.schoolId, ip });
    return (await this.requestView([row]))[0];
  }

  /** A signed-in teacher's or administrator's own staff record. */
  async mine(actor: AuthUser) {
    const s = await this.prisma.staff.findUnique({ where: { userId: actor.id }, select: { id: true } });
    return s ? this.record(s.id) : null;
  }

  /** Teacher and pupil numbers for a school or area. */
  async counts(where: Prisma.StaffWhereInput) {
    const groups = await this.prisma.staff.groupBy({ by: ['category'], where: { ...where, status: { in: [StaffStatus.ACTIVE, StaffStatus.ON_LEAVE] } }, _count: true });
    const get = (c: string) => groups.find((g) => g.category === c)?._count ?? 0;
    return { teaching: get('TEACHING'), nonTeaching: get('NON_TEACHING') };
  }
}
