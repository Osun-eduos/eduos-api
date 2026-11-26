import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, StudentStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { className } from '../common/classes';
import { nextAdmissionNumber, nextLearnerId } from '../common/counter';
import { isoDate, parseDate, today } from '../common/dates';
import { isOversight, seesLga } from '../common/scope';
import { currentSession, requireCurrentSession } from '../common/session';
import { holidayOn } from '../common/holidays';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import { LEVELS_FOR_SCHOOL } from '../common/classes';
import { UsersService } from '../users/users.service';
import { EnrolStudentDto, GuardianDto, ListStudentsQuery, UpdateStudentDto, WithdrawDto } from './dto';

/** What a summary row needs, for the current session. */
export function summaryInclude(sessionId: string | null) {
  return {
    currentSchool: { select: { id: true, name: true, code: true } },
    enrolments: { where: { leftOn: null }, select: { admissionNumber: true, admittedOn: true } },
    placements: { where: { sessionId: sessionId ?? '00000000-0000-0000-0000-000000000000' }, include: { classArm: true } },
  } satisfies Prisma.StudentInclude;
}

type SummaryRow = Prisma.StudentGetPayload<{ include: ReturnType<typeof summaryInclude> }>;

export function studentSummary(s: SummaryRow) {
  const p = s.placements[0];
  return {
    id: s.id,
    learnerId: s.learnerId,
    fullName: [s.surname, s.firstName, s.middleName].filter(Boolean).join(' '),
    surname: s.surname,
    firstName: s.firstName,
    middleName: s.middleName,
    sex: s.sex,
    dateOfBirth: isoDate(s.dateOfBirth),
    status: s.status,
    school: s.currentSchool,
    admissionNumber: s.enrolments[0]?.admissionNumber ?? null,
    currentClass: p ? { id: p.classArm.id, name: className(p.classArm.level, p.classArm.arm) } : null,
  };
}

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly users: UsersService,
    private readonly sms: SmsService,
    private readonly notifications: NotificationsService,
  ) {}

  private async sessionId() {
    return (await currentSession(this.prisma))?.id ?? null;
  }

  /** Throws unless the actor may see this student. Returns the student's current school. */
  async assertCanView(actor: AuthUser, studentId: string) {
    const s = await this.prisma.student.findUnique({ where: { id: studentId }, select: { currentSchoolId: true, currentSchool: { select: { lga: true } } } });
    if (!s) throw new NotFoundException('Student not found.');
    // Oversight users see students of schools in their area. Students with no current school (withdrawn) are state-level records.
    if (isOversight(actor) && (seesLga(actor, s.currentSchool?.lga) || (!actor.lga && !s.currentSchoolId))) return s;
    if (actor.role === Role.SCHOOL_ADMIN && s.currentSchoolId === actor.schoolId) return s;
    if (actor.role === Role.TEACHER) {
      const sid = await this.sessionId();
      const taught = await this.prisma.classPlacement.count({
        where: { studentId, sessionId: sid ?? undefined, classArm: { OR: [{ classTeacherId: actor.id }, { subjects: { some: { teacherId: actor.id } } }] } },
      });
      if (taught) return s;
    }
    if (actor.role === Role.PARENT) {
      if (await this.prisma.studentGuardian.count({ where: { studentId, parentId: actor.id } })) return s;
    }
    throw new NotFoundException('Student not found.');
  }

  /** Throws unless the actor is the administrator of the student's current school. */
  private async ownStudent(actor: AuthUser, studentId: string) {
    if (actor.role !== Role.SCHOOL_ADMIN) throw new ForbiddenException('Only the student’s school can do this.');
    const s = await this.prisma.student.findUnique({ where: { id: studentId } });
    if (!s || s.currentSchoolId !== actor.schoolId) throw new NotFoundException('Student not found.');
    return s;
  }

  private validateDob(value: string) {
    const dob = parseDate(value, 'Date of birth');
    const age = (Date.now() - dob.getTime()) / (365.25 * 86_400_000);
    if (age < 2 || age > 30) throw new BadRequestException('Check the date of birth: the student would be under 2 or over 30 years old.');
    return dob;
  }

  /** Checks a class belongs to the school and the current session, and has room. */
  private async checkClass(tx: Prisma.TransactionClient, schoolId: string, classArmId: string, sessionId: string, ignoringStudent?: string) {
    const c = await tx.classArm.findUnique({ where: { id: classArmId } });
    if (!c || c.schoolId !== schoolId || c.sessionId !== sessionId) throw new BadRequestException('Choose a class from your school for the current session.');
    const count = await tx.classPlacement.count({ where: { classArmId, ...(ignoringStudent ? { studentId: { not: ignoringStudent } } : {}) } });
    if (count >= c.capacity) throw new BadRequestException(`${className(c.level, c.arm)} is full (${c.capacity} students).`);
    return c;
  }

  private async addGuardian(tx: Prisma.TransactionClient, actor: AuthUser, studentId: string, g: GuardianDto, ip: string | null) {
    if (!!g.parentId === !!g.newParent) throw new BadRequestException('Choose an existing parent account or enter a new parent, not both.');
    let parentId = g.parentId;
    let created: Awaited<ReturnType<UsersService['createInTx']>> | null = null;
    if (g.newParent) {
      created = await this.users.createInTx(tx, actor, g.newParent, Role.PARENT, actor.schoolId, ip);
      parentId = created.user.id;
    } else {
      const p = await tx.user.findUnique({ where: { id: parentId } });
      if (!p || p.role !== Role.PARENT || p.schoolId !== actor.schoolId || !p.isActive) throw new BadRequestException('Choose an active parent account from your school.');
    }
    try {
      await tx.studentGuardian.create({ data: { studentId, parentId: parentId!, relationship: g.relationship } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('That parent is already linked to this student.');
      throw e;
    }
    await this.audit.record({ actorId: actor.id, action: 'student.guardian_added', targetType: 'student', targetId: studentId, schoolId: actor.schoolId, meta: { parentId: parentId!, relationship: g.relationship }, ip }, tx);
    return created;
  }

  async enrol(actor: AuthUser, dto: EnrolStudentDto, ip: string | null) {
    const dob = this.validateDob(dto.dateOfBirth);
    const admittedOn = dto.admittedOn ? parseDate(dto.admittedOn, 'Admission date') : today();
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: actor.schoolId! } });
    if (!school.isActive) throw new ForbiddenException('Your school is deactivated.');

    if (!dto.confirmDuplicate) {
      const matches = await this.prisma.student.findMany({
        where: { dateOfBirth: dob, status: StudentStatus.ACTIVE, surname: { equals: dto.surname, mode: 'insensitive' }, firstName: { equals: dto.firstName, mode: 'insensitive' } },
        include: { currentSchool: { select: { name: true, code: true } } },
        take: 5,
      });
      if (matches.length) {
        throw new ConflictException({
          code: 'POSSIBLE_DUPLICATE',
          message: 'A student with the same name and date of birth is already enrolled. If it is the same child, ask their school to transfer them instead.',
          matches: matches.map((m) => ({ learnerId: m.learnerId, school: m.currentSchool?.name ?? null, sameSchool: m.currentSchoolId === school.id })),
        });
      }
    }

    if (dto.entryLevel && !LEVELS_FOR_SCHOOL[school.level].includes(dto.entryLevel)) throw new BadRequestException('Choose a class level your school teaches.');
    const result = await this.prisma.$transaction(async (tx) => {
      const session = dto.classArmId ? await requireCurrentSession(tx) : await currentSession(tx);
      const cls = dto.classArmId ? await this.checkClass(tx, school.id, dto.classArmId, session!.id) : null;
      const student = await tx.student.create({
        data: {
          learnerId: await nextLearnerId(tx),
          surname: dto.surname, firstName: dto.firstName, middleName: dto.middleName, sex: dto.sex, dateOfBirth: dob,
          stateOfOrigin: dto.stateOfOrigin, lgaOfOrigin: dto.lgaOfOrigin, homeAddress: dto.homeAddress, previousSchool: dto.previousSchool, currentSchoolId: school.id,
        },
      });
      const admissionNumber = await nextAdmissionNumber(tx, school.id);
      await tx.enrolment.create({ data: { studentId: student.id, schoolId: school.id, admissionNumber, admittedOn, entryLevel: cls?.level ?? dto.entryLevel ?? null } });
      if (dto.classArmId) await tx.classPlacement.create({ data: { studentId: student.id, classArmId: dto.classArmId, sessionId: session!.id } });
      await this.audit.record({ actorId: actor.id, action: 'student.enrolled', targetType: 'student', targetId: student.id, schoolId: school.id, meta: { learnerId: student.learnerId }, ip }, tx);
      const parent = dto.guardian ? await this.addGuardian(tx, actor, student.id, dto.guardian, ip) : null;
      const row = await tx.student.findUniqueOrThrow({ where: { id: student.id }, include: summaryInclude(session?.id ?? null) });
      return { student: studentSummary(row), parent };
    });
    // Telling the guardian must never undo the enrolment.
    await this.welcomeGuardians(school, result.student).catch((e) => console.error('Guardian could not be told about the enrolment', e));
    return result;
  }

  /** The guardian gets the admission number and learner ID by text, and in their inbox if they use the app. */
  private async welcomeGuardians(school: { id: string; name: string }, st: ReturnType<typeof studentSummary>) {
    const links = await this.notifications.parentsOf([st.id]);
    const child = `${st.firstName} ${st.surname}`;
    const body = `${child} is now enrolled at ${school.name}. Admission no. ${st.admissionNumber}, learner ID ${st.learnerId}.`;
    for (const l of links) {
      await this.notifications.notify([l.parent.id], { kind: 'ENROLMENT', title: 'Enrolment confirmed', body, link: `/students/${st.id}`, studentId: st.id, key: `enrolled:${st.id}:${school.id}` });
    }
    const texts = links.filter((l) => l.parent.phone).map((l) => ({ to: l.parent.phone!, parentId: l.parent.id, studentId: st.id, schoolId: school.id, body: `${body} - Osun EduOS` }));
    if (texts.length) await this.sms.queue('ENROLMENT', texts);
  }

  async list(actor: AuthUser, q: ListStudentsQuery) {
    const sid = await this.sessionId();
    const and: Prisma.StudentWhereInput[] = [];
    if (isOversight(actor)) {
      if (q.schoolId) and.push({ currentSchoolId: q.schoolId });
      if (actor.lga) and.push({ currentSchool: { lga: actor.lga } });
    } else if (actor.role === Role.SCHOOL_ADMIN) {
      and.push({ currentSchoolId: actor.schoolId });
    } else if (actor.role === Role.TEACHER) {
      and.push({ placements: { some: { sessionId: sid ?? undefined, classArm: { classTeacherId: actor.id } } } });
    } else if (actor.role === Role.PARENT) {
      and.push({ guardians: { some: { parentId: actor.id } } });
    }
    and.push({ status: q.status ?? StudentStatus.ACTIVE });
    if (q.classId) and.push({ placements: { some: { classArmId: q.classId } } });
    if (q.unplaced === 'true') and.push({ placements: { none: { sessionId: sid ?? undefined } } });
    if (q.q?.trim()) {
      const words = q.q.trim().split(/\s+/);
      and.push(...words.map((w) => ({
        OR: [
          { surname: { contains: w, mode: 'insensitive' as const } },
          { firstName: { contains: w, mode: 'insensitive' as const } },
          { middleName: { contains: w, mode: 'insensitive' as const } },
          { learnerId: { contains: w.toUpperCase() } },
          { enrolments: { some: { admissionNumber: { contains: w }, leftOn: null } } },
        ],
      })));
    }
    if (isOversight(actor) && !q.schoolId && !q.q?.trim()) throw new BadRequestException('Search by name or learner ID, or choose a school.');
    const rows = await this.prisma.student.findMany({ where: { AND: and }, include: summaryInclude(sid), orderBy: [{ surname: 'asc' }, { firstName: 'asc' }], take: 1000 });
    const out = rows.map(studentSummary);
    if (q.stats !== 'true' || !rows.length) return out;
    const stats = await this.termStats(rows.map((r) => r.id), actor.role === Role.SCHOOL_ADMIN ? actor.schoolId : null);
    return out.map((r) => ({ ...r, ...(stats.get(r.id) ?? { attendanceRate: null, termAverage: null, transferredIn: false }) }));
  }

  /** This term's attendance rate and average subject score per student, and whether they transferred in. */
  private async termStats(ids: string[], schoolId: string | null) {
    const term = await this.prisma.term.findFirst({ where: { isCurrent: true } });
    const out = new Map<string, { attendanceRate: number | null; termAverage: number | null; transferredIn: boolean }>();
    for (const id of ids) out.set(id, { attendanceRate: null, termAverage: null, transferredIn: false });
    if (term) {
      const att = await this.prisma.$queryRaw<{ studentId: string; marks: bigint; here: bigint }[]>`
        SELECT m."studentId", count(*) AS marks, count(*) FILTER (WHERE m.status IN ('PRESENT', 'LATE')) AS here
        FROM "AttendanceMark" m JOIN "AttendanceRegister" r ON r.id = m."registerId"
        WHERE m."studentId" = ANY(${ids}::uuid[]) AND r.date BETWEEN ${term.startDate} AND ${term.endDate}
        GROUP BY m."studentId"`;
      for (const a of att) out.get(a.studentId)!.attendanceRate = Number(a.marks) ? Math.round((Number(a.here) / Number(a.marks)) * 1000) / 10 : null;
      const sc = await this.prisma.score.groupBy({ by: ['studentId'], where: { studentId: { in: ids }, total: { not: null }, sheet: { termId: term.id } }, _avg: { total: true } });
      for (const x of sc) out.get(x.studentId)!.termAverage = x._avg.total === null ? null : Math.round(x._avg.total * 10) / 10;
    }
    if (schoolId) {
      const tr = await this.prisma.transfer.findMany({ where: { studentId: { in: ids }, toSchoolId: schoolId, status: 'ACCEPTED' }, select: { studentId: true } });
      for (const t of tr) out.get(t.studentId)!.transferredIn = true;
    }
    return out;
  }

  async get(actor: AuthUser, id: string) {
    await this.assertCanView(actor, id);
    const sid = await this.sessionId();
    const s = await this.prisma.student.findUniqueOrThrow({
      where: { id },
      include: {
        ...summaryInclude(sid),
        guardians: { include: { parent: { select: { id: true, fullName: true, email: true, phone: true, isActive: true } } } },
      },
    });
    const staff = actor.role !== Role.PARENT;
    const [history, placements, transfers] = await Promise.all([
      this.prisma.enrolment.findMany({ where: { studentId: id }, include: { school: { select: { name: true, code: true } } }, orderBy: { admittedOn: 'asc' } }),
      this.prisma.classPlacement.findMany({ where: { studentId: id }, include: { classArm: { include: { school: { select: { name: true } } } }, session: true }, orderBy: { placedAt: 'asc' } }),
      staff ? this.prisma.transfer.findMany({ where: { studentId: id }, include: { fromSchool: { select: { name: true } }, toSchool: { select: { name: true } } }, orderBy: { requestedAt: 'desc' } }) : Promise.resolve([]),
    ]);
    return {
      ...studentSummary(s),
      stateOfOrigin: s.stateOfOrigin,
      lgaOfOrigin: s.lgaOfOrigin,
      previousSchool: staff ? s.previousSchool : undefined,
      homeAddress: staff ? s.homeAddress : undefined,
      guardians: s.guardians
        .filter((g) => staff || g.parentId === actor.id)
        .map((g) => ({ relationship: g.relationship, ...g.parent })),
      enrolments: history.map((e) => ({
        school: e.school.name, schoolCode: e.school.code, admissionNumber: e.admissionNumber,
        admittedOn: isoDate(e.admittedOn), leftOn: isoDate(e.leftOn), leftReason: e.leftReason,
      })),
      classHistory: placements.map((p) => ({ session: p.session.name, className: className(p.classArm.level, p.classArm.arm), school: p.classArm.school.name })),
      transfers: transfers.map((t) => ({ id: t.id, status: t.status, from: t.fromSchool.name, to: t.toSchool.name, reason: t.reason, note: t.note, requestedAt: t.requestedAt, decidedAt: t.decidedAt })),
    };
  }

  async update(actor: AuthUser, id: string, dto: UpdateStudentDto, ip: string | null) {
    const s = await this.ownStudent(actor, id);
    const data: Prisma.StudentUpdateInput = {
      surname: dto.surname, firstName: dto.firstName, sex: dto.sex,
      middleName: dto.middleName === undefined ? undefined : dto.middleName || null,
      stateOfOrigin: dto.stateOfOrigin === undefined ? undefined : dto.stateOfOrigin || null,
      lgaOfOrigin: dto.lgaOfOrigin === undefined ? undefined : dto.lgaOfOrigin || null,
      homeAddress: dto.homeAddress === undefined ? undefined : dto.homeAddress || null,
      previousSchool: dto.previousSchool === undefined ? undefined : dto.previousSchool || null,
      dateOfBirth: dto.dateOfBirth ? this.validateDob(dto.dateOfBirth) : undefined,
    };
    await this.prisma.student.update({ where: { id }, data });
    await this.audit.record({ actorId: actor.id, action: 'student.updated', targetType: 'student', targetId: id, schoolId: s.currentSchoolId, ip });
    return this.get(actor, id);
  }

  /** Puts a student in a class for the current session, moves them, or (null) removes them from their class. */
  async place(actor: AuthUser, id: string, classArmId: string | null, ip: string | null) {
    const s = await this.ownStudent(actor, id);
    if (s.status !== StudentStatus.ACTIVE) throw new BadRequestException('This student is not active.');
    await this.prisma.$transaction(async (tx) => {
      const session = await requireCurrentSession(tx);
      const existing = await tx.classPlacement.findUnique({ where: { studentId_sessionId: { studentId: id, sessionId: session.id } }, include: { classArm: true } });
      if (classArmId === null) {
        if (existing) await tx.classPlacement.delete({ where: { id: existing.id } });
      } else {
        const c = await this.checkClass(tx, s.currentSchoolId!, classArmId, session.id, id);
        await tx.classPlacement.upsert({
          where: { studentId_sessionId: { studentId: id, sessionId: session.id } },
          create: { studentId: id, classArmId, sessionId: session.id },
          update: { classArmId, placedAt: new Date() },
        });
        await this.audit.record({
          actorId: actor.id, action: existing ? 'student.moved' : 'student.placed', targetType: 'student', targetId: id, schoolId: s.currentSchoolId,
          meta: { from: existing ? className(existing.classArm.level, existing.classArm.arm) : null, to: className(c.level, c.arm) }, ip,
        }, tx);
        return;
      }
      await this.audit.record({ actorId: actor.id, action: 'student.unplaced', targetType: 'student', targetId: id, schoolId: s.currentSchoolId, ip }, tx);
    });
    return this.get(actor, id);
  }

  async linkGuardian(actor: AuthUser, id: string, dto: GuardianDto, ip: string | null) {
    await this.ownStudent(actor, id);
    const parent = await this.prisma.$transaction((tx) => this.addGuardian(tx, actor, id, dto, ip));
    return { student: await this.get(actor, id), parent };
  }

  async unlinkGuardian(actor: AuthUser, id: string, parentId: string, ip: string | null) {
    const s = await this.ownStudent(actor, id);
    const { count } = await this.prisma.studentGuardian.deleteMany({ where: { studentId: id, parentId } });
    if (!count) throw new NotFoundException('That parent is not linked to this student.');
    await this.audit.record({ actorId: actor.id, action: 'student.guardian_removed', targetType: 'student', targetId: id, schoolId: s.currentSchoolId, meta: { parentId }, ip });
    return this.get(actor, id);
  }

  async withdraw(actor: AuthUser, id: string, dto: WithdrawDto, ip: string | null) {
    const s = await this.ownStudent(actor, id);
    if (s.status !== StudentStatus.ACTIVE) throw new BadRequestException('This student is not active.');
    const date = dto.date ? parseDate(dto.date, 'Date') : today();
    await this.prisma.$transaction(async (tx) => {
      const session = await currentSession(tx);
      await tx.enrolment.updateMany({ where: { studentId: id, leftOn: null }, data: { leftOn: date, leftReason: `Withdrawn: ${dto.reason}` } });
      if (session) await tx.classPlacement.deleteMany({ where: { studentId: id, sessionId: session.id } });
      await tx.transfer.updateMany({ where: { studentId: id, status: 'REQUESTED' }, data: { status: 'CANCELLED', decidedAt: new Date(), decidedById: actor.id, note: 'Student withdrawn' } });
      await tx.student.update({ where: { id }, data: { status: StudentStatus.WITHDRAWN, currentSchoolId: null } });
      await this.audit.record({ actorId: actor.id, action: 'student.withdrawn', targetType: 'student', targetId: id, schoolId: s.currentSchoolId, meta: { reason: dto.reason }, ip }, tx);
    });
    return { ok: true };
  }

  /** Classes the signed-in teacher leads this session, with their students. */
  async myClasses(actor: AuthUser) {
    const session = await currentSession(this.prisma);
    if (!session) return { session: null, classes: [] };
    const arms = await this.prisma.classArm.findMany({
      where: { classTeacherId: actor.id, sessionId: session.id },
      include: {
        registers: { where: { date: today() }, select: { id: true } },
        placements: {
          include: {
            student: {
              include: {
                ...summaryInclude(session.id),
                guardians: { include: { parent: { select: { fullName: true, phone: true, email: true } } } },
              },
            },
          },
        },
      },
    });
    const now = today();
    const holiday = await holidayOn(this.prisma, now);
    const weekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;
    return {
      session: session.name,
      today: { isSchoolDay: !holiday && !weekend && now >= session.startDate && now <= session.endDate, holiday: holiday?.name ?? null },
      classes: arms.map((a) => ({
        id: a.id, name: className(a.level, a.arm), capacity: a.capacity, registerTakenToday: a.registers.length > 0,
        students: a.placements
          .map((p) => ({
            ...studentSummary(p.student),
            guardians: p.student.guardians.map((g) => ({ relationship: g.relationship, ...g.parent })),
          }))
          .sort((x, y) => x.fullName.localeCompare(y.fullName)),
      })),
    };
  }

  /** Children linked to the signed-in parent. */
  async myChildren(actor: AuthUser) {
    const sid = await this.sessionId();
    const links = await this.prisma.studentGuardian.findMany({
      where: { parentId: actor.id },
      include: { student: { include: { ...summaryInclude(sid), placements: { where: { sessionId: sid ?? undefined }, include: { classArm: { include: { classTeacher: { select: { fullName: true } } } } } } } } },
    });
    return links.map((l) => {
      const p = l.student.placements[0];
      return { relationship: l.relationship, classTeacher: p?.classArm.classTeacher?.fullName ?? null, ...studentSummary(l.student) };
    });
  }
}
