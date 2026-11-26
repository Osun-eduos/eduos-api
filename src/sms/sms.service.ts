import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AttendanceStatus, Prisma, SmsStatus } from '@prisma/client';
import { isoDate, today } from '../common/dates';
import { PrismaService } from '../prisma/prisma.service';
import { KudiSmsProvider, LogProvider, SmsProvider } from './providers';

export const ABSENCE = 'ABSENCE';
const MAX_ATTEMPTS = 3;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Bello Kemi was absent from Ilesa Grammar School today, Wed 25 Nov. ..." Kept short so it fits one or two SMS pages. */
export function absenceText(student: { firstName: string; surname: string }, school: string, date: Date) {
  const day = `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  const s = school.length > 40 ? school.slice(0, 39).trimEnd() + '.' : school;
  return `${student.firstName} ${student.surname} was marked absent at ${s} today, ${day}. If this is unexpected, please contact the school. - Osun EduOS`;
}

@Injectable()
export class SmsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SmsService');
  readonly provider: SmsProvider;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {
    const token = config.get<string>('KUDISMS_TOKEN');
    const sender = config.get<string>('KUDISMS_SENDER_ID');
    const want = config.get<string>('SMS_PROVIDER') ?? (token ? 'kudisms' : 'log');
    if (want === 'kudisms' && token && sender) {
      const route = config.get<string>('KUDISMS_ROUTE') === 'sms' ? 'sms' : 'corporate';
      this.provider = new KudiSmsProvider({ token, senderId: sender, route, baseUrl: config.get<string>('KUDISMS_BASE_URL') || undefined });
    } else {
      if (want === 'kudisms') this.log.warn('SMS_PROVIDER is kudisms but KUDISMS_TOKEN or KUDISMS_SENDER_ID is missing. Texts are logged, not sent.');
      this.provider = new LogProvider();
    }
  }

  /** Minutes between saving a register and texting parents, so a corrected register cancels the text. */
  get delayMinutes() {
    return Math.max(0, Number(this.config.get('ABSENCE_SMS_DELAY_MINUTES') ?? 15));
  }

  onModuleInit() {
    if (this.config.get('SMS_WORKER') === 'off') return;
    const every = Math.max(10, Number(this.config.get('SMS_WORKER_SECONDS') ?? 60)) * 1000;
    this.timer = setInterval(() => void this.sendDue().catch((e) => this.log.error(e)), every);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Brings the absence texts for one register in line with its marks: queue a text for each parent of a child marked
   * absent today, and cancel queued texts for children no longer absent. Only today's registers send texts.
   */
  async syncAbsences(classArmId: string, date: Date) {
    if (date.getTime() !== today().getTime()) return;
    const reg = await this.prisma.attendanceRegister.findUnique({
      where: { classArmId_date: { classArmId, date } },
      include: {
        classArm: { include: { school: { select: { id: true, name: true, absenceSms: true } } } },
        marks: {
          include: {
            student: { select: { id: true, firstName: true, surname: true, guardians: { include: { parent: { select: { id: true, phone: true, isActive: true } } } } } },
          },
        },
      },
    });
    if (!reg) return;
    const school = reg.classArm.school;
    const absent = reg.marks.filter((m) => m.status === AttendanceStatus.ABSENT);
    const notAbsent = reg.marks.filter((m) => m.status !== AttendanceStatus.ABSENT).map((m) => m.studentId);
    if (notAbsent.length) {
      await this.prisma.smsMessage.updateMany({
        where: { kind: ABSENCE, date, studentId: { in: notAbsent }, status: SmsStatus.QUEUED },
        data: { status: SmsStatus.CANCELLED, error: 'The register was corrected.' },
      });
    }
    if (!school.absenceSms) {
      await this.prisma.smsMessage.updateMany({
        where: { kind: ABSENCE, date, schoolId: school.id, status: SmsStatus.QUEUED },
        data: { status: SmsStatus.CANCELLED, error: 'The school has switched absence texts off.' },
      });
      return;
    }
    const sendAfter = new Date(Date.now() + this.delayMinutes * 60_000);
    for (const m of absent) {
      for (const g of m.student.guardians) {
        if (!g.parent.phone || !g.parent.isActive) continue;
        const key = { kind_studentId_parentId_date: { kind: ABSENCE, studentId: m.studentId, parentId: g.parent.id, date } };
        const body = absenceText(m.student, school.name, date);
        const existing = await this.prisma.smsMessage.findUnique({ where: key });
        if (!existing) {
          try {
            await this.prisma.smsMessage.create({
              data: { kind: ABSENCE, to: g.parent.phone, body, schoolId: school.id, studentId: m.studentId, parentId: g.parent.id, date, sendAfter },
            });
          } catch (e) {
            if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
          }
        } else if (existing.status === SmsStatus.CANCELLED) {
          await this.prisma.smsMessage.update({ where: { id: existing.id }, data: { status: SmsStatus.QUEUED, sendAfter, to: g.parent.phone, body, error: null } });
        }
      }
    }
  }

  /** Sends texts whose time has come. Safe to run on several API instances at once. */
  async sendDue(limit = 50) {
    if (this.running) return 0;
    this.running = true;
    try {
      // Messages stuck in SENDING (an instance stopped mid-send) go back to the queue after 10 minutes.
      await this.prisma.smsMessage.updateMany({
        where: { status: SmsStatus.SENDING, updatedAt: { lt: new Date(Date.now() - 600_000) } },
        data: { status: SmsStatus.QUEUED },
      });
      const claimed = await this.prisma.$queryRaw<{ id: string; to: string; body: string; attempts: number; date: Date | null }[]>`
        UPDATE "SmsMessage" SET status = 'SENDING', attempts = attempts + 1, "updatedAt" = now()
        WHERE id IN (
          SELECT id FROM "SmsMessage" WHERE status = 'QUEUED' AND "sendAfter" <= now()
          ORDER BY "sendAfter" LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        RETURNING id, "to", body, attempts, date`;
      for (const m of claimed) {
        // An absence text is only useful on the day.
        if (m.date && isoDate(m.date) !== isoDate(today())) {
          await this.prisma.smsMessage.update({ where: { id: m.id }, data: { status: SmsStatus.CANCELLED, error: 'Not sent on the day.' } });
          continue;
        }
        const r = await this.provider.send(m.to, m.body);
        if (r.ok) {
          await this.prisma.smsMessage.update({
            where: { id: m.id },
            data: { status: SmsStatus.SENT, sentAt: new Date(), provider: this.provider.name, providerId: r.providerId, cost: r.cost, error: null },
          });
        } else if (r.retry && m.attempts < MAX_ATTEMPTS) {
          await this.prisma.smsMessage.update({
            where: { id: m.id },
            data: { status: SmsStatus.QUEUED, sendAfter: new Date(Date.now() + 5 * 60_000 * m.attempts), provider: this.provider.name, error: r.error },
          });
        } else {
          await this.prisma.smsMessage.update({ where: { id: m.id }, data: { status: SmsStatus.FAILED, provider: this.provider.name, error: r.error } });
          this.log.warn(`SMS ${m.id} failed: ${r.error}`);
        }
      }
      return claimed.length;
    } finally {
      this.running = false;
    }
  }
}
