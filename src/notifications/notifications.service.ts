import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FcmProvider, PushProvider, readServiceAccount } from './push';

export interface NewNotification {
  kind: 'ABSENCE' | 'RESULTS' | 'TRANSFER' | 'NOTICE';
  title: string;
  body: string;
  link?: string;
  studentId?: string;
  /** Made at most once per person per key. */
  key?: string;
  visibleAfter?: Date;
}

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Notifications');
  /** Null when push is not set up (no FIREBASE_SERVICE_ACCOUNT): the inbox still works. */
  push: PushProvider | null;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {
    const raw = config.get<string>('FIREBASE_SERVICE_ACCOUNT');
    const account = readServiceAccount(raw);
    if (raw && !account) this.log.warn('FIREBASE_SERVICE_ACCOUNT is set but is not a valid service account. Push is off.');
    this.push = account ? new FcmProvider(account) : null;
  }

  onModuleInit() {
    if (this.config.get('SMS_WORKER') === 'off' || !this.push) return;
    this.timer = setInterval(() => void this.pushDue().catch((e) => this.log.error(e)), 30_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Adds a notification for each person. Ones with a key they already have are skipped. Returns how many were made. */
  async notify(userIds: string[], n: NewNotification, tx: Prisma.TransactionClient = this.prisma) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return 0;
    const r = await tx.notification.createMany({
      data: ids.map((userId) => ({ userId, kind: n.kind, title: n.title, body: n.body, link: n.link, studentId: n.studentId, key: n.key, visibleAfter: n.visibleAfter ?? new Date() })),
      skipDuplicates: true,
    });
    return r.count;
  }

  /** Withdraws notifications nobody has seen yet (still waiting to show), e.g. after a register is corrected. */
  async withdrawPending(keys: string[]) {
    if (!keys.length) return 0;
    const r = await this.prisma.notification.deleteMany({ where: { key: { in: keys }, readAt: null, visibleAfter: { gt: new Date() } } });
    return r.count;
  }

  /** Parents linked to these students, with active accounts. */
  async parentsOf(studentIds: string[]) {
    const links = await this.prisma.studentGuardian.findMany({
      where: { studentId: { in: studentIds }, parent: { isActive: true } },
      select: { studentId: true, parent: { select: { id: true, phone: true, fullName: true } } },
    });
    return links;
  }

  async inbox(userId: string, limit = 100) {
    const where = { userId, visibleAfter: { lte: new Date() } };
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { visibleAfter: 'desc' }, take: limit }),
      this.prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    return {
      unread,
      items: items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, studentId: n.studentId, read: !!n.readAt, at: n.visibleAfter })),
    };
  }

  async unreadCount(userId: string) {
    return this.prisma.notification.count({ where: { userId, readAt: null, visibleAfter: { lte: new Date() } } });
  }

  async markRead(userId: string, ids?: string[]) {
    const r = await this.prisma.notification.updateMany({
      where: { userId, readAt: null, visibleAfter: { lte: new Date() }, ...(ids ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });
    return { updated: r.count, unread: await this.unreadCount(userId) };
  }

  async registerDevice(userId: string, token: string, platform: string) {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      // A phone that changes hands moves to the new person.
      update: { userId, platform, lastSeenAt: new Date() },
    });
    return { ok: true, push: !!this.push };
  }

  async removeDevice(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
    return { ok: true };
  }

  /** Pushes notifications that have become visible to the phones of the people they are for. */
  async pushDue(limit = 200) {
    if (!this.push || this.running) return 0;
    this.running = true;
    try {
      const due = await this.prisma.notification.findMany({
        where: { pushedAt: null, visibleAfter: { lte: new Date(), gt: new Date(Date.now() - 86_400_000) } },
        orderBy: { visibleAfter: 'asc' },
        take: limit,
        include: { user: { select: { devices: { select: { token: true } } } } },
      });
      let sent = 0;
      for (const n of due) {
        await this.prisma.notification.update({ where: { id: n.id }, data: { pushedAt: new Date() } });
        for (const d of n.user.devices) {
          const r = await this.push.send(d.token, { title: n.title, body: n.body, data: { id: n.id, kind: n.kind, link: n.link ?? '' } });
          if (r.ok) sent++;
          else if (r.gone) await this.prisma.deviceToken.deleteMany({ where: { token: d.token } });
          else this.log.warn(`Push failed: ${r.error}`);
        }
      }
      return sent;
    } finally {
      this.running = false;
    }
  }
}
