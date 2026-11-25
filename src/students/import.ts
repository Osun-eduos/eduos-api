import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, Role, Sex, StudentStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { className } from '../common/classes';
import { nextAdmissionNumber, nextLearnerId } from '../common/counter';
import { isoDate, today } from '../common/dates';
import { normaliseEmail, normalisePhone } from '../common/identity';
import { currentSession } from '../common/session';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { RELATIONSHIPS } from './dto';

export const IMPORT_MAX_ROWS = 500;

const str = ({ value }: { value: unknown }) => (value === null || value === undefined ? undefined : String(value).trim() || undefined);
const Cell = () => (target: object, key: string) => {
  Transform(str)(target, key);
  IsOptional()(target, key);
  IsString()(target, key);
  MaxLength(250)(target, key);
};

/** One spreadsheet row, as typed. Everything is checked by the import itself so each row gets its own messages. */
export class ImportRowDto {
  @Cell() surname?: string;
  @Cell() firstName?: string;
  @Cell() middleName?: string;
  @Cell() sex?: string;
  @Cell() dateOfBirth?: string;
  @Cell() className?: string;
  @Cell() admittedOn?: string;
  @Cell() stateOfOrigin?: string;
  @Cell() lgaOfOrigin?: string;
  @Cell() homeAddress?: string;
  @Cell() parentName?: string;
  @Cell() parentPhone?: string;
  @Cell() parentEmail?: string;
  @Cell() relationship?: string;
}

export class ImportStudentsDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'The file has no students in it.' })
  @ArrayMaxSize(IMPORT_MAX_ROWS, { message: `Import at most ${IMPORT_MAX_ROWS} students at a time. Split the file and import each part.` })
  @ValidateNested({ each: true })
  @Type(() => ImportRowDto)
  rows: ImportRowDto[];

  /** Check the rows and report problems without saving anything. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/**
 * Reads a date as typed in a Nigerian spreadsheet: YYYY-MM-DD, or day first (DD/MM/YYYY, D-M-YYYY, DD.MM.YYYY).
 * Returns null if it is not a real date.
 */
export function readDate(value: string): Date | null {
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (match) [y, m, d] = [+match[1], +match[2], +match[3]];
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value))) [d, m, y] = [+match[1], +match[2], +match[3]];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

const SEX: Record<string, Sex> = { f: Sex.F, female: Sex.F, girl: Sex.F, m: Sex.M, male: Sex.M, boy: Sex.M };
/** "JSS 2A", "jss2 a", "JSS-2-A" and "Primary 4 B" all compare equal. */
export const classKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const nameKey = (surname: string, first: string, dob: Date) => `${surname.toLowerCase()}|${first.toLowerCase()}|${isoDate(dob)}`;
const titleRelationship = (r: string) => RELATIONSHIPS.find((x) => x.toLowerCase() === r.toLowerCase());

type ParentPlan = { kind: 'new'; key: string; fullName: string; phone: string | null; email: string | null } | { kind: 'existing'; id: string; fullName: string };

interface Checked {
  row: number;
  errors: string[];
  warnings: string[];
  student?: {
    surname: string; firstName: string; middleName?: string; sex: Sex; dateOfBirth: Date; admittedOn: Date;
    stateOfOrigin?: string; lgaOfOrigin?: string; homeAddress?: string; classArmId: string | null; className: string | null;
  };
  parent?: ParentPlan & { relationship: string };
}

@Injectable()
export class StudentImportService {
  constructor(private readonly prisma: PrismaService, private readonly users: UsersService, private readonly audit: AuditService) {}

  async import(actor: AuthUser, dto: ImportStudentsDto, ip: string | null) {
    const school = await this.prisma.school.findUniqueOrThrow({ where: { id: actor.schoolId! } });
    if (!school.isActive) throw new ForbiddenException('Your school is deactivated.');
    const session = await currentSession(this.prisma);
    const checked = await this.check(actor.schoolId!, session?.id ?? null, dto.rows);
    const report = checked.map((c) => ({
      row: c.row,
      ok: c.errors.length === 0,
      errors: c.errors,
      warnings: c.warnings,
      student: c.student
        ? { fullName: [c.student.surname, c.student.firstName, c.student.middleName].filter(Boolean).join(' '), sex: c.student.sex, dateOfBirth: isoDate(c.student.dateOfBirth), className: c.student.className }
        : null,
      parent: c.parent ? { fullName: c.parent.fullName, relationship: c.parent.relationship, account: c.parent.kind } : null,
    }));
    const valid = checked.filter((c) => !c.errors.length);
    const summary = { total: checked.length, ready: valid.length, withProblems: checked.length - valid.length };
    if (dto.dryRun || !valid.length) return { dryRun: true, ...summary, imported: 0, rows: report, parents: [] };

    const created = new Map<string, { fullName: string; phone: string | null; email: string | null; tempPassword: string; children: string[] }>();
    const imported = await this.prisma.$transaction(
      async (tx) => {
        let n = 0;
        for (const c of valid) {
          const s = c.student!;
          const student = await tx.student.create({
            data: {
              learnerId: await nextLearnerId(tx),
              surname: s.surname, firstName: s.firstName, middleName: s.middleName, sex: s.sex, dateOfBirth: s.dateOfBirth,
              stateOfOrigin: s.stateOfOrigin, lgaOfOrigin: s.lgaOfOrigin, homeAddress: s.homeAddress, currentSchoolId: school.id,
            },
          });
          await tx.enrolment.create({ data: { studentId: student.id, schoolId: school.id, admissionNumber: await nextAdmissionNumber(tx, school.id), admittedOn: s.admittedOn } });
          if (s.classArmId) await tx.classPlacement.create({ data: { studentId: student.id, classArmId: s.classArmId, sessionId: session!.id } });
          await this.audit.record({ actorId: actor.id, action: 'student.enrolled', targetType: 'student', targetId: student.id, schoolId: school.id, meta: { learnerId: student.learnerId, imported: true }, ip }, tx);
          if (c.parent) {
            let parentId: string;
            const childName = `${s.surname} ${s.firstName}`;
            if (c.parent.kind === 'existing') parentId = c.parent.id;
            else {
              const done = created.get(c.parent.key);
              if (done) {
                parentId = (await tx.user.findFirstOrThrow({ where: c.parent.phone ? { phone: c.parent.phone } : { email: c.parent.email! }, select: { id: true } })).id;
                done.children.push(childName);
              } else {
                const p = await this.users.createInTx(tx, actor, { fullName: c.parent.fullName, phone: c.parent.phone ?? undefined, email: c.parent.email ?? undefined }, Role.PARENT, school.id, ip);
                parentId = p.user.id;
                created.set(c.parent.key, { fullName: p.user.fullName, phone: p.user.phone, email: p.user.email, tempPassword: p.tempPassword, children: [childName] });
              }
            }
            await tx.studentGuardian.create({ data: { studentId: student.id, parentId, relationship: c.parent.relationship } });
          }
          n++;
        }
        await this.audit.record({ actorId: actor.id, action: 'students.imported', targetType: 'school', targetId: school.id, schoolId: school.id, meta: { imported: n, skipped: summary.withProblems, newParents: created.size }, ip }, tx);
        return n;
      },
      { timeout: 300_000, maxWait: 10_000 },
    );
    return { dryRun: false, ...summary, imported, rows: report, parents: [...created.values()] };
  }

  /** Checks every row against the school's classes, existing students and parent accounts, and against the other rows. */
  private async check(schoolId: string, sessionId: string | null, rows: ImportRowDto[]): Promise<Checked[]> {
    const classes = sessionId ? await this.prisma.classArm.findMany({ where: { schoolId, sessionId }, include: { _count: { select: { placements: true } } } }) : [];
    const byName = new Map(classes.map((c) => [classKey(className(c.level, c.arm)), c]));
    const room = new Map(classes.map((c) => [c.id, c.capacity - c._count.placements]));
    const seenStudents = new Map<string, number>();
    const newParents = new Map<string, { fullName: string; row: number }>();
    const now = today();
    const out: Checked[] = [];

    for (const [i, r] of rows.entries()) {
      const c: Checked = { row: i + 2, errors: [], warnings: [] }; // Row 1 is the header in the spreadsheet.
      out.push(c);
      const err = (m: string) => c.errors.push(m);
      if (!r.surname || r.surname.length < 2) err('Surname is missing.');
      if (!r.firstName || r.firstName.length < 2) err('First name is missing.');
      for (const [k, max] of [['surname', 60], ['firstName', 60], ['middleName', 60], ['stateOfOrigin', 40], ['lgaOfOrigin', 60]] as const) {
        if ((r[k]?.length ?? 0) > max) err(`${k === 'firstName' ? 'First name' : k === 'middleName' ? 'Middle name' : k === 'stateOfOrigin' ? 'State of origin' : k === 'lgaOfOrigin' ? 'LGA of origin' : 'Surname'} is too long.`);
      }
      const sex = r.sex ? SEX[r.sex.toLowerCase()] : undefined;
      if (!sex) err(r.sex ? `Sex "${r.sex}" is not F or M.` : 'Sex is missing (F or M).');
      const dob = r.dateOfBirth ? readDate(r.dateOfBirth) : null;
      if (!dob) err(r.dateOfBirth ? `Date of birth "${r.dateOfBirth}" is not a date. Use DD/MM/YYYY.` : 'Date of birth is missing.');
      else {
        const age = (now.getTime() - dob.getTime()) / (365.25 * 86_400_000);
        if (age < 2 || age > 30) err('Check the date of birth: the student would be under 2 or over 30 years old.');
      }
      let admittedOn = now;
      if (r.admittedOn) {
        const a = readDate(r.admittedOn);
        if (!a) err(`Admission date "${r.admittedOn}" is not a date. Use DD/MM/YYYY.`);
        else if (a > now) err('The admission date is in the future.');
        else admittedOn = a;
      }

      let cls: (typeof classes)[number] | undefined;
      if (r.className) {
        cls = byName.get(classKey(r.className));
        if (!sessionId) err('No academic session is open, so students cannot be placed in classes yet. Leave the class empty or wait for the Ministry.');
        else if (!cls) err(`There is no class called "${r.className}" this session. Create it on the Classes page first, or fix the name.`);
        else if ((room.get(cls.id) ?? 0) <= 0) err(`${className(cls.level, cls.arm)} is full (${cls.capacity} students).`);
      } else c.warnings.push('No class given. The student is enrolled without a class.');

      if (r.surname && r.firstName && dob) {
        const key = nameKey(r.surname, r.firstName, dob);
        const earlier = seenStudents.get(key);
        if (earlier) err(`Same name and date of birth as row ${earlier}.`);
        else seenStudents.set(key, c.row);
      }

      // Parent.
      if (r.parentName || r.parentPhone || r.parentEmail) {
        const relationship = r.relationship ? titleRelationship(r.relationship) : 'Guardian';
        if (!relationship) err(`Relationship "${r.relationship}" is not one of: ${RELATIONSHIPS.join(', ')}.`);
        if (!r.relationship) c.warnings.push('No relationship given, so the parent is recorded as Guardian.');
        const phone = r.parentPhone ? normalisePhone(r.parentPhone) : null;
        if (r.parentPhone && !phone) err(`Parent phone "${r.parentPhone}" is not a valid Nigerian number.`);
        let email: string | null = null;
        if (r.parentEmail) {
          email = normaliseEmail(r.parentEmail);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) err(`Parent email "${r.parentEmail}" is not valid.`);
        }
        if (!r.parentPhone && !r.parentEmail) err('Give the parent a phone number or email so they can sign in.');
        if (phone || email) {
          const existing = await this.prisma.user.findFirst({ where: { OR: [...(phone ? [{ phone }] : []), ...(email ? [{ email }] : [])] } });
          if (existing) {
            if (existing.role !== Role.PARENT || existing.schoolId !== schoolId || !existing.isActive) err('The parent phone or email belongs to another account that is not an active parent at your school.');
            else if (relationship) c.parent = { kind: 'existing', id: existing.id, fullName: existing.fullName, relationship };
          } else {
            const key = phone ?? email!;
            const name = r.parentName?.trim();
            if (!name || name.length < 3) err('Parent name is missing.');
            else {
              const other = newParents.get(key);
              if (other && other.fullName.toLowerCase() !== name.toLowerCase()) err(`The parent phone or email is used for "${other.fullName}" on row ${other.row}.`);
              else {
                if (!other) newParents.set(key, { fullName: name, row: c.row });
                else c.warnings.push(`Linked to the same new parent as row ${other.row}.`);
                if (relationship) c.parent = { kind: 'new', key, fullName: other?.fullName ?? name, phone, email, relationship };
              }
            }
          }
        }
      }

      if (!c.errors.length && sex && dob) {
        c.student = {
          surname: r.surname!, firstName: r.firstName!, middleName: r.middleName, sex, dateOfBirth: dob, admittedOn,
          stateOfOrigin: r.stateOfOrigin, lgaOfOrigin: r.lgaOfOrigin, homeAddress: r.homeAddress,
          classArmId: cls?.id ?? null, className: cls ? className(cls.level, cls.arm) : null,
        };
        if (cls) room.set(cls.id, (room.get(cls.id) ?? 0) - 1);
      }
    }

    // Students already enrolled anywhere in the state with the same name and date of birth.
    const candidates = out.filter((c) => c.student);
    if (candidates.length) {
      const matches = await this.prisma.student.findMany({
        where: {
          status: StudentStatus.ACTIVE,
          OR: candidates.map((c) => ({ dateOfBirth: c.student!.dateOfBirth, surname: { equals: c.student!.surname, mode: Prisma.QueryMode.insensitive }, firstName: { equals: c.student!.firstName, mode: Prisma.QueryMode.insensitive } })),
        },
        include: { currentSchool: { select: { id: true, name: true } } },
      });
      const found = new Map(matches.map((m) => [nameKey(m.surname, m.firstName, m.dateOfBirth), m]));
      for (const c of candidates) {
        const m = found.get(nameKey(c.student!.surname, c.student!.firstName, c.student!.dateOfBirth));
        if (!m) continue;
        c.errors.push(
          m.currentSchool?.id === schoolId
            ? `Already enrolled at your school (${m.learnerId}).`
            : `A student with the same name and date of birth is enrolled at ${m.currentSchool?.name ?? 'another school'} (${m.learnerId}). If it is the same child, ask for a transfer. If not, enrol them on the Students page.`,
        );
        if (c.student!.classArmId) room.set(c.student!.classArmId, (room.get(c.student!.classArmId) ?? 0) + 1);
        delete c.student;
        delete c.parent;
      }
    }
    for (const c of out) if (c.errors.length) delete c.parent;
    return out;
  }
}

