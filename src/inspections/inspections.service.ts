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
    const { overall, issues } = assess(r.answers as Answers);
    return {
      id: r.id, clientId: r.clientId, school: r.school, inspector: r.inspector, visitedOn: isoDate(r.visitedOn), overall, createdAt: r.createdAt,
      issues: full ? issues : issues.slice(0, 3), issueCount: issues.length, photoCount: r.photos.length, notes: r.notes,
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

  async list(actor: AuthUser, q: { schoolId?: string; overall?: string; mine?: string }) {
    const where: Prisma.InspectionWhereInput = {};
    if (actor.role === Role.SCHOOL_ADMIN) where.schoolId = actor.schoolId!;
    else if (isOversight(actor)) where.school = schoolsInScope(actor);
    else throw new ForbiddenException('You do not have access to this.');
    if (q.schoolId) where.schoolId = actor.role === Role.SCHOOL_ADMIN ? actor.schoolId! : q.schoolId;
    if (q.overall) where.overall = q.overall;
    if (q.mine === 'true') where.inspectorId = actor.id;
    const rows = await this.prisma.inspection.findMany({ where, include, orderBy: [{ visitedOn: 'desc' }, { createdAt: 'desc' }], take: 300 });
    return rows.map((r) => this.view(r));
  }

  async get(actor: AuthUser, id: string) {
    return this.view(await this.load(actor, id), true);
  }

  /** Records a visit. A retried upload with the same clientId returns the inspection already saved. */
  async create(actor: AuthUser, dto: { clientId: string; schoolId: string; visitedOn: string; answers: unknown; notes?: string }, ip: string | null) {
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
        data: { clientId: dto.clientId, schoolId: school.id, inspectorId: actor.id, visitedOn, template: TEMPLATE_VERSION, answers, overall, notes: dto.notes },
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
}
