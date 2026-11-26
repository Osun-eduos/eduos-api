import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/auth-user';
import { addDays, isoDate, parseDate, today } from '../common/dates';
import { Answers, assess, checkAnswers, CHECKLIST, RATINGS, TEMPLATE_VERSION } from '../common/inspection';
import { isOversight, schoolsInScope, seesLga } from '../common/scope';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

export const INSPECTORS: Role[] = [Role.INSPECTOR, Role.LGA_OFFICER];
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS = 30;
/** How long after a visit the inspector may still add photos (uploads can wait for a signal). */
const PHOTO_DAYS = 30;
const SECTIONS = new Set([...CHECKLIST.map((s) => s.key), 'general']);

/** Recognises JPEG, PNG and WebP from their first bytes, whatever the upload claims. */
export function imageType(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const include = {
  school: { select: { id: true, name: true, code: true, lga: true } },
  inspector: { select: { id: true, fullName: true, role: true } },
  photos: { select: { id: true, clientId: true, section: true, caption: true, bytes: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.InspectionInclude;
type Row = Prisma.InspectionGetPayload<{ include: typeof include }>;

@Injectable()
export class InspectionsService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService, private readonly audit: AuditService) {}

  template() {
    return { version: TEMPLATE_VERSION, ratings: RATINGS, sections: CHECKLIST };
  }

  private view(r: Row, full = false) {
    // Answers are checked on the way in; records imported from elsewhere may be partial, so fall back to the stored grade.
    let judged: ReturnType<typeof assess>;
    try {
      judged = assess(r.answers as Answers);
    } catch {
      judged = { overall: r.overall as ReturnType<typeof assess>['overall'], issues: [] };
    }
    const { overall, issues } = judged;
    return {
      id: r.id, clientId: r.clientId, school: r.school, inspector: r.inspector, visitedOn: isoDate(r.visitedOn), overall, createdAt: r.createdAt,
      issues: full ? issues : issues.slice(0, 3), issueCount: issues.length, photoCount: r.photos.length, notes: r.notes, actionNeeded: r.actionNeeded,
      followUp: r.followUp ? { status: r.followUp, note: r.followUpNote, at: r.followUpAt } : null,
      ...(full ? { template: r.template, answers: r.answers, photos: r.photos.map((p) => ({ id: p.id, clientId: p.clientId, section: p.section, caption: p.caption, bytes: p.bytes })) } : {}),
    };
  }

  private canSee(actor: AuthUser, school: { id: string; lga: string }) {
    return seesLga(actor, school.lga) || (actor.role === Role.SCHOOL_ADMIN && actor.schoolId === school.id);
  }

  private async load(actor: AuthUser, id: string) {
    const r = await this.prisma.inspection.findUnique({ where: { id }, include });
    if (!r || !this.canSee(actor, r.school)) throw new NotFoundException('Inspection not found.');
    return r;
  }

  async list(actor: AuthUser, q: { schoolId?: string; overall?: string; mine?: string; followUp?: string }) {
    const where: Prisma.InspectionWhereInput = {};
    if (actor.role === Role.SCHOOL_ADMIN) where.schoolId = actor.schoolId!;
    else if (isOversight(actor)) where.school = schoolsInScope(actor);
    else throw new ForbiddenException('You do not have access to this.');
    if (q.schoolId) where.schoolId = actor.role === Role.SCHOOL_ADMIN ? actor.schoolId! : q.schoolId;
    if (q.overall) where.overall = q.overall;
    if (q.mine === 'true') where.inspectorId = actor.id;
    if (q.followUp) where.followUp = q.followUp === 'NONE' ? null : q.followUp;
    const rows = await this.prisma.inspection.findMany({ where, include, orderBy: [{ visitedOn: 'desc' }, { createdAt: 'desc' }], take: 300 });
    return rows.map((r) => this.view(r));
  }

  async get(actor: AuthUser, id: string) {
    return this.view(await this.load(actor, id), true);
  }

  /** Records a visit. A retried upload with the same clientId returns the inspection already saved. */
  async create(actor: AuthUser, dto: { clientId: string; schoolId: string; visitedOn: string; answers: unknown; notes?: string; actionNeeded?: string }, ip: string | null) {
    const existing = await this.prisma.inspection.findUnique({ where: { clientId: dto.clientId }, include });
    if (existing) {
      if (existing.inspectorId !== actor.id) throw new ConflictException('That inspection id is already used.');
      return { ...this.view(existing, true), duplicate: true };
    }
    const school = await this.prisma.school.findUnique({ where: { id: dto.schoolId } });
    if (!school || !seesLga(actor, school.lga)) throw new NotFoundException('School not found.');
    if (!school.isActive) throw new BadRequestException('That school is deactivated.');
    const visitedOn = parseDate(dto.visitedOn, 'Visit date');
    if (visitedOn > today()) throw new BadRequestException('The visit date is in the future.');
    if (visitedOn < addDays(today(), -60)) throw new BadRequestException('Record visits within 60 days.');
    const { answers, problems } = checkAnswers(dto.answers);
    if (problems.length) throw new BadRequestException({ message: problems[0], problems });
    const { overall } = assess(answers);
    try {
      const r = await this.prisma.inspection.create({
        data: { clientId: dto.clientId, schoolId: school.id, inspectorId: actor.id, visitedOn, template: TEMPLATE_VERSION, answers, overall, notes: dto.notes, actionNeeded: dto.actionNeeded },
        include,
      });
      await this.audit.record({ actorId: actor.id, action: 'inspection.recorded', targetType: 'inspection', targetId: r.id, schoolId: school.id, meta: { overall, visitedOn: dto.visitedOn }, ip });
      return { ...this.view(r, true), duplicate: false };
    } catch (e) {
      // Two copies of the same upload arriving at once.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const won = await this.prisma.inspection.findUnique({ where: { clientId: dto.clientId }, include });
        if (won && won.inspectorId === actor.id) return { ...this.view(won, true), duplicate: true };
      }
      throw e;
    }
  }

  async addPhoto(actor: AuthUser, id: string, file: { buffer: Buffer; size: number } | undefined, meta: { clientId: string; section: string; caption?: string }, ip: string | null) {
    const r = await this.load(actor, id);
    if (r.inspectorId !== actor.id) throw new ForbiddenException('Only the inspector who made the visit can add photos.');
    const again = await this.prisma.inspectionPhoto.findUnique({ where: { clientId: meta.clientId } });
    if (again) {
      if (again.inspectionId !== id) throw new ConflictException('That photo id is already used.');
      return { id: again.id, clientId: again.clientId, section: again.section, caption: again.caption, bytes: again.bytes, duplicate: true };
    }
    if (!file?.buffer?.length) throw new BadRequestException('Attach a photo.');
    if (file.size > MAX_PHOTO_BYTES) throw new BadRequestException('Photos can be at most 5 MB.');
    const type = imageType(file.buffer);
    if (!type) throw new BadRequestException('Photos must be JPEG, PNG or WebP images.');
    if (!SECTIONS.has(meta.section)) throw new BadRequestException('Unknown checklist section for the photo.');
    if (r.visitedOn < addDays(today(), -PHOTO_DAYS)) throw new BadRequestException(`Photos can be added up to ${PHOTO_DAYS} days after the visit.`);
    if (r.photos.length >= MAX_PHOTOS) throw new BadRequestException(`An inspection can have at most ${MAX_PHOTOS} photos.`);
    const key = `inspections/${r.schoolId}/${r.id}/${randomUUID()}.${type.split('/')[1]}`;
    const storageKey = await this.storage.put(key, file.buffer, type);
    try {
      const p = await this.prisma.inspectionPhoto.create({
        data: { clientId: meta.clientId, inspectionId: id, section: meta.section, caption: meta.caption, contentType: type, bytes: file.size, storageKey, data: storageKey === 'db' ? file.buffer : null },
      });
      await this.audit.record({ actorId: actor.id, action: 'inspection.photo_added', targetType: 'inspection', targetId: id, schoolId: r.schoolId, meta: { section: meta.section }, ip });
      return { id: p.id, clientId: p.clientId, section: p.section, caption: p.caption, bytes: p.bytes, duplicate: false };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const won = await this.prisma.inspectionPhoto.findUnique({ where: { clientId: meta.clientId } });
        if (won && won.inspectionId === id) return { id: won.id, clientId: won.clientId, section: won.section, caption: won.caption, bytes: won.bytes, duplicate: true };
      }
      throw e;
    }
  }

  async photo(actor: AuthUser, photoId: string) {
    const p = await this.prisma.inspectionPhoto.findUnique({ where: { id: photoId }, include: { inspection: { select: { school: { select: { id: true, lga: true } } } } } });
    if (!p || !this.canSee(actor, p.inspection.school)) throw new NotFoundException('Photo not found.');
    const body = p.storageKey === 'db' ? Buffer.from(p.data ?? []) : await this.storage.get(p.storageKey);
    return { body, contentType: p.contentType };
  }

  /** The Ministry or LGA marks what happens next after a report: urgent, planned, or resolved. */
  async setFollowUp(actor: AuthUser, id: string, dto: { status: string; note?: string }, ip: string | null) {
    const r = await this.load(actor, id);
    if (!isOversight(actor)) throw new ForbiddenException('Only the Ministry or the LGA can set the follow-up.');
    await this.prisma.inspection.update({ where: { id }, data: { followUp: dto.status, followUpNote: dto.note ?? null, followUpById: actor.id, followUpAt: new Date() } });
    await this.audit.record({ actorId: actor.id, action: 'inspection.follow_up', targetType: 'inspection', targetId: id, schoolId: r.schoolId, meta: { status: dto.status, note: dto.note ?? null }, ip });
    return this.get(actor, id);
  }

  /**
   * Minimum standards by LGA, from each school's latest inspection: water, working toilets with some for girls,
   * power, a computer room, a library and a laboratory. Also classrooms against pupils (one room per 40) and how
   * reports are being followed up.
   */
  async standards(actor: AuthUser) {
    if (!isOversight(actor)) throw new ForbiddenException('You do not have access to this.');
    const schools = await this.prisma.school.findMany({
      where: { isActive: true, ...schoolsInScope(actor) },
      select: {
        id: true, lga: true, classrooms: true,
        inspections: { orderBy: [{ visitedOn: 'desc' }, { createdAt: 'desc' }], take: 1, select: { answers: true, overall: true, followUp: true } },
        _count: { select: { students: { where: { status: 'ACTIVE' } } } },
      },
    });
    type Row = { lga: string; schools: number; inspected: number; water: number; toilets: number; power: number; ict: number; library: number; lab: number; classrooms: number; usable: number; pupils: number; needed: number; shortfall: number; schoolsShort: number; needsAction: number; urgent: number; planned: number; resolved: number; noFollowUp: number };
    const blank = (lga: string): Row => ({ lga, schools: 0, inspected: 0, water: 0, toilets: 0, power: 0, ict: 0, library: 0, lab: 0, classrooms: 0, usable: 0, pupils: 0, needed: 0, shortfall: 0, schoolsShort: 0, needsAction: 0, urgent: 0, planned: 0, resolved: 0, noFollowUp: 0 });
    const by = new Map<string, Row>();
    const state = blank('Osun State');
    for (const s of schools) {
      if (!by.has(s.lga)) by.set(s.lga, blank(s.lga));
      const rows = [by.get(s.lga)!, state];
      const last = s.inspections[0];
      const pupils = s._count.students;
      const a = (last?.answers as Answers | undefined)?.classrooms ? (last!.answers as Answers) : undefined;
      const usable = a ? (a.classrooms.usable as number) : null;
      const rooms = a ? (a.classrooms.total as number) : s.classrooms;
      const needed = Math.ceil(pupils / 40);
      for (const r of rows) {
        r.schools++;
        r.pupils += pupils;
        r.needed += needed;
        if (rooms != null) r.classrooms += rooms;
        if (!a || !last) continue;
        r.inspected++;
        r.usable += usable!;
        if (usable! < needed) { r.shortfall += needed - usable!; r.schoolsShort++; }
        if (a.water.source !== 'NONE' && a.water.working) r.water++;
        if ((a.toilets.working as number) > 0 && (a.toilets.girls as number) > 0) r.toilets++;
        if (a.power.source !== 'NONE') r.power++;
        if (a.facilities?.ict) r.ict++;
        if (a.facilities?.library) r.library++;
        if (a.facilities?.laboratory) r.lab++;
        if (last.overall === 'POOR' || last.overall === 'CRITICAL') {
          r.needsAction++;
          if (last.followUp === 'URGENT') r.urgent++;
          else if (last.followUp === 'PLANNED') r.planned++;
          else if (last.followUp === 'RESOLVED') r.resolved++;
          else r.noFollowUp++;
        }
      }
    }
    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
    const out = (r: Row) => ({
      ...r,
      rates: { water: pct(r.water, r.inspected), toilets: pct(r.toilets, r.inspected), power: pct(r.power, r.inspected), ict: pct(r.ict, r.inspected), library: pct(r.library, r.inspected), lab: pct(r.lab, r.inspected) },
      pupilsPerClassroom: r.usable ? Math.round(r.pupils / r.usable) : null,
    });
    return { standards: ['water', 'toilets', 'power', 'ict', 'library', 'lab'], pupilsPerClassroom: 40, state: out(state), lgas: [...by.values()].sort((a, b) => a.lga.localeCompare(b.lga)).map(out) };
  }
}
