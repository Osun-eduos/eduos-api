import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceStatus, Prisma, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { className, LEVEL_ORDER } from '../common/classes';
import { addDays, isoDate, parseDate, today } from '../common/dates';
import { holidayOn } from '../common/holidays';
import { isOversight, schoolsInScope, seesLga } from '../common/scope';
import { currentSession } from '../common/session';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../students/students.service';
import { MarkDto } from './dto';

/** How many days back a class teacher may take or correct a register. School administrators can correct any day in the session. */
export const TEACHER_EDIT_DAYS = 7;

type Counts = Record<AttendanceStatus, number>;
const emptyCounts = (): Counts => ({ PRESENT: 0, LATE: 0, ABSENT: 0, EXCUSED: 0 });

/** Share of marked days the student was in school (present or late), as a percentage with one decimal. */
export function attendanceRate(c: Counts): number | null {
  const marked = c.PRESENT + c.LATE + c.ABSENT + c.EXCUSED;
  return marked ? Math.round(((c.PRESENT + c.LATE) / marked) * 1000) / 10 : null;
}

const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
const fullName = (s: { surname: string; firstName: string; middleName: string | null }) => [s.surname, s.firstName, s.middleName].filter(Boolean).join(' ');

const classInclude = {
  school: { select: { id: true, name: true, lga: true } },
  session: true,
  classTeacher: { select: { id: true, fullName: true } },
} satisfies Prisma.ClassArmInclude;
type ClassRow = Prisma.ClassArmGetPayload<{ include: typeof classInclude }>;

const studentSelect = { id: true, learnerId: true, surname: true, firstName: true, middleName: true, sex: true } satisfies Prisma.StudentSelect;

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly students: StudentsService,
  ) {}

  /** Loads a class the actor may see (or, with `edit`, take the register for). */
  private async classFor(actor: AuthUser, classId: string, edit = false): Promise<ClassRow> {
    const c = await this.prisma.classArm.findUnique({ where: { id: classId }, include: classInclude });
    const visible =
      c &&
      (seesLga(actor, c.school.lga) ||
        (actor.role === Role.SCHOOL_ADMIN && c.schoolId === actor.schoolId) ||
        (actor.role === Role.TEACHER && c.classTeacherId === actor.id));
    if (!c || !visible) throw new NotFoundException('Class not found.');
    if (edit && isOversight(actor)) throw new ForbiddenException('Registers are taken by the school.');
    return c;
  }

  /** Validates that a date is a school day in the class's session, and says whether the actor can still change it. */
  private async schoolDay(actor: AuthUser, c: ClassRow, value: string) {
    const date = parseDate(value, 'Date');
    const now = today();
    if (date > now) throw new BadRequestException('You cannot take a register for a future date.');
    if (date < c.session.startDate || date > c.session.endDate) {
      throw new BadRequestException(`That date is outside the ${c.session.name} session (${isoDate(c.session.startDate)} to ${isoDate(c.session.endDate)}).`);
    }
    if (isWeekend(date)) throw new BadRequestException('That date is a weekend.');
    const holiday = await holidayOn(this.prisma, date);
    if (holiday) throw new BadRequestException(`That date is a holiday (${holiday.name}). Registers are not taken on holidays.`);
    let lockedReason: string | null = null;
    if (isOversight(actor)) lockedReason = 'Registers are taken by the school.';
    else if (!c.session.isCurrent) lockedReason = `The ${c.session.name} session is closed.`;
    else if (actor.role === Role.TEACHER && date < addDays(now, -TEACHER_EDIT_DAYS)) {
      lockedReason = `Class teachers can change registers for the last ${TEACHER_EDIT_DAYS} days. Ask your school administrator to correct older ones.`;
    }
    return { date, lockedReason };
  }

  /** Students placed in the class who had been admitted to the school by that date. */
  private async onRoll(classArmId: string, schoolId: string, date: Date) {
    const rows = await this.prisma.classPlacement.findMany({
      where: { classArmId, student: { enrolments: { some: { schoolId, leftOn: null, admittedOn: { lte: date } } } } },
      include: { student: { select: studentSelect } },
    });
    return rows;
  }

  async getRegister(actor: AuthUser, classId: string, value: string) {
    const c = await this.classFor(actor, classId);
    const { date, lockedReason } = await this.schoolDay(actor, c, value);
    const [reg, placements] = await Promise.all([
      this.prisma.attendanceRegister.findUnique({
        where: { classArmId_date: { classArmId: c.id, date } },
        include: {
          marks: { include: { student: { select: studentSelect } } },
          takenBy: { select: { fullName: true } },
          updatedBy: { select: { fullName: true } },
        },
      }),
      this.onRoll(c.id, c.schoolId, date),
    ]);
    const marks = new Map((reg?.marks ?? []).map((m) => [m.studentId, m]));
    const rows = new Map<string, { id: string; learnerId: string; fullName: string; sex: string; status: AttendanceStatus | null; note: string | null; inClass: boolean }>();
    for (const p of placements) {
      const m = marks.get(p.studentId);
      rows.set(p.studentId, { id: p.student.id, learnerId: p.student.learnerId, fullName: fullName(p.student), sex: p.student.sex, status: m?.status ?? null, note: m?.note ?? null, inClass: true });
    }
    for (const m of reg?.marks ?? []) {
      if (!rows.has(m.studentId)) {
        rows.set(m.studentId, { id: m.student.id, learnerId: m.student.learnerId, fullName: fullName(m.student), sex: m.student.sex, status: m.status, note: m.note, inClass: false });
      }
    }
    const students = [...rows.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
    const totals = emptyCounts();
    students.forEach((s) => s.status && totals[s.status]++);
    return {
      class: { id: c.id, name: className(c.level, c.arm), school: c.school, classTeacher: c.classTeacher, session: c.session.name },
      date: value,
      editable: !lockedReason,
      lockedReason,
      register: reg ? { takenBy: reg.takenBy.fullName, takenAt: reg.takenAt, updatedBy: reg.updatedBy?.fullName ?? null, updatedAt: reg.updatedById ? reg.updatedAt : null } : null,
      students,
      totals,
    };
  }

  async saveRegister(actor: AuthUser, dto: { classId: string; date: string; marks: MarkDto[] }, ip: string | null) {
    const c = await this.classFor(actor, dto.classId, true);
    const { date, lockedReason } = await this.schoolDay(actor, c, dto.date);
    if (lockedReason) throw new ForbiddenException(lockedReason);

    const [placements, existing] = await Promise.all([
      this.onRoll(c.id, c.schoolId, date),
      this.prisma.attendanceRegister.findUnique({ where: { classArmId_date: { classArmId: c.id, date } }, include: { marks: { select: { studentId: true } } } }),
    ]);
    const placed = new Set(placements.map((p) => p.studentId));
    const allowed = new Set([...placed, ...(existing?.marks.map((m) => m.studentId) ?? [])]);
    const seen = new Set<string>();
    for (const m of dto.marks) {
      if (seen.has(m.studentId)) throw new BadRequestException('Each student can be marked only once.');
      if (!allowed.has(m.studentId)) throw new BadRequestException(`A student in the register is not in ${className(c.level, c.arm)}.`);
      seen.add(m.studentId);
    }
    const missing = [...placed].filter((id) => !seen.has(id)).length;
    if (!placed.size) throw new BadRequestException('There are no students in this class yet.');
    if (missing) throw new BadRequestException(`Mark every student. ${missing} student${missing === 1 ? ' is' : 's are'} not marked.`);

    await this.prisma.$transaction(async (tx) => {
      const reg = existing
        ? await tx.attendanceRegister.update({ where: { id: existing.id }, data: { updatedById: actor.id } })
        : await tx.attendanceRegister.create({ data: { classArmId: c.id, date, takenById: actor.id } });
      for (const m of dto.marks) {
        const note = m.note ?? null;
        await tx.attendanceMark.upsert({
          where: { registerId_studentId: { registerId: reg.id, studentId: m.studentId } },
          create: { registerId: reg.id, studentId: m.studentId, status: m.status, note },
          update: { status: m.status, note },
        });
      }
      const absent = dto.marks.filter((m) => m.status === AttendanceStatus.ABSENT).length;
      await this.audit.record(
        {
          actorId: actor.id, action: existing ? 'attendance.updated' : 'attendance.taken', targetType: 'class', targetId: c.id, schoolId: c.schoolId,
          meta: { class: className(c.level, c.arm), date: dto.date, students: dto.marks.length, absent }, ip,
        },
        tx,
      );
    });
    return this.getRegister(actor, c.id, dto.date);
  }

  /** Which classes have taken today's (or a given day's) register, with counts. For school administrators and the Ministry. */
  async day(actor: AuthUser, value?: string, schoolId?: string) {
    let sid: string;
    if (actor.role === Role.SCHOOL_ADMIN) sid = actor.schoolId!;
    else if (isOversight(actor)) {
      if (!schoolId) throw new BadRequestException('Choose a school.');
      const school = await this.prisma.school.findUnique({ where: { id: schoolId }, select: { lga: true } });
      if (!school || !seesLga(actor, school.lga)) throw new NotFoundException('School not found.');
      sid = schoolId;
    } else throw new ForbiddenException('You do not have access to this.');
    const date = value ? parseDate(value, 'Date') : today();
    if (date > today()) throw new BadRequestException('That date is in the future.');
    const session = await currentSession(this.prisma);
    if (!session) return { date: isoDate(date), session: null, isSchoolDay: false, classes: [], totals: { classes: 0, taken: 0, ...emptyCounts() } };
    const holiday = await holidayOn(this.prisma, date);
    const isSchoolDay = !holiday && !isWeekend(date) && date >= session.startDate && date <= session.endDate;
    const arms = await this.prisma.classArm.findMany({
      where: { schoolId: sid, sessionId: session.id },
      include: {
        classTeacher: { select: { id: true, fullName: true } },
        _count: { select: { placements: true } },
        registers: { where: { date }, include: { takenBy: { select: { fullName: true } }, marks: { select: { status: true } } } },
      },
    });
    const totals = { classes: 0, taken: 0, ...emptyCounts() };
    const classes = arms
      .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.arm.localeCompare(b.arm))
      .map((a) => {
        const reg = a.registers[0];
        const counts = emptyCounts();
        reg?.marks.forEach((m) => counts[m.status]++);
        if (a._count.placements) totals.classes++;
        if (reg) {
          totals.taken++;
          (Object.keys(counts) as AttendanceStatus[]).forEach((k) => (totals[k] += counts[k]));
        }
        return {
          id: a.id, name: className(a.level, a.arm), classTeacher: a.classTeacher, students: a._count.placements,
          taken: !!reg, takenBy: reg?.takenBy.fullName ?? null, takenAt: reg?.takenAt ?? null, counts: reg ? counts : null,
        };
      });
    return { date: isoDate(date), session: session.name, isSchoolDay, holiday: holiday?.name ?? null, classes, totals };
  }

  private range(session: { startDate: Date; endDate: Date }, from?: string, to?: string) {
    const end = session.endDate < today() ? session.endDate : today();
    const f = from ? parseDate(from, 'From') : session.startDate;
    const t = to ? parseDate(to, 'To') : end;
    if (f > t) throw new BadRequestException('The start of the range is after the end.');
    return { from: f, to: t };
  }

  /** Per-student totals and per-day totals for one class over a date range (default: the session so far). */
  async classSummary(actor: AuthUser, classId: string, from?: string, to?: string) {
    const c = await this.classFor(actor, classId);
    const r = this.range(c.session, from, to);
    const [registers, placements] = await Promise.all([
      this.prisma.attendanceRegister.findMany({
        where: { classArmId: c.id, date: { gte: r.from, lte: r.to } },
        include: { marks: { include: { student: { select: studentSelect } } } },
        orderBy: { date: 'asc' },
      }),
      this.prisma.classPlacement.findMany({ where: { classArmId: c.id }, include: { student: { select: studentSelect } } }),
    ]);
    const per = new Map<string, { id: string; learnerId: string; fullName: string; inClass: boolean; counts: Counts }>();
    for (const p of placements) per.set(p.studentId, { id: p.student.id, learnerId: p.student.learnerId, fullName: fullName(p.student), inClass: true, counts: emptyCounts() });
    const days = registers.map((reg) => {
      const counts = emptyCounts();
      for (const m of reg.marks) {
        counts[m.status]++;
        if (!per.has(m.studentId)) per.set(m.studentId, { id: m.student.id, learnerId: m.student.learnerId, fullName: fullName(m.student), inClass: false, counts: emptyCounts() });
        per.get(m.studentId)!.counts[m.status]++;
      }
      return { date: isoDate(reg.date), ...counts };
    });
    const students = [...per.values()]
      .map((s) => ({ ...s, rate: attendanceRate(s.counts) }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    return { class: { id: c.id, name: className(c.level, c.arm), session: c.session.name }, from: isoDate(r.from), to: isoDate(r.to), registers: registers.length, students, days };
  }

  /** One student's attendance over a range (default: the current session so far), across every class and school they were in. */
  async student(actor: AuthUser, studentId: string, from?: string, to?: string) {
    await this.students.assertCanView(actor, studentId);
    const session = await currentSession(this.prisma);
    if (!session && !(from && to)) return { from: null, to: null, counts: emptyCounts(), rate: null, records: [] };
    const r = this.range(session ?? { startDate: parseDate(from!, 'From'), endDate: parseDate(to!, 'To') }, from, to);
    const marks = await this.prisma.attendanceMark.findMany({
      where: { studentId, register: { date: { gte: r.from, lte: r.to } } },
      include: { register: { include: { classArm: { include: { school: { select: { name: true } } } } } } },
      orderBy: { register: { date: 'desc' } },
    });
    const counts = emptyCounts();
    marks.forEach((m) => counts[m.status]++);
    return {
      from: isoDate(r.from),
      to: isoDate(r.to),
      counts,
      rate: attendanceRate(counts),
      records: marks.map((m) => ({
        date: isoDate(m.register.date), status: m.status, note: m.note,
        className: className(m.register.classArm.level, m.register.classArm.arm), school: m.register.classArm.school.name,
      })),
    };
  }

  /** Today's register progress for the home screen. */
  async todayStats(actor: AuthUser) {
    const session = await currentSession(this.prisma);
    const date = today();
    if (!session) return null;
    const holiday = await holidayOn(this.prisma, date);
    const isSchoolDay = !holiday && !isWeekend(date) && date >= session.startDate && date <= session.endDate;
    const scope: Prisma.ClassArmWhereInput = { sessionId: session.id, placements: { some: {} } };
    if (!isOversight(actor)) scope.schoolId = actor.schoolId!;
    else if (actor.lga) scope.school = schoolsInScope(actor);
    const [classes, taken, marks] = await Promise.all([
      this.prisma.classArm.count({ where: scope }),
      this.prisma.attendanceRegister.count({ where: { date, classArm: scope } }),
      this.prisma.attendanceMark.groupBy({ by: ['status'], where: { register: { date, classArm: scope } }, _count: true }),
    ]);
    const counts = emptyCounts();
    marks.forEach((m) => (counts[m.status] = m._count));
    return { date: isoDate(date), isSchoolDay, holiday: holiday?.name ?? null, classes, taken, counts, rate: attendanceRate(counts) };
  }
}
