import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  schoolId?: string | null;
  meta?: Prisma.InputJsonValue;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(entry: AuditEntry, tx: Prisma.TransactionClient = this.prisma) {
    return tx.auditLog.create({ data: { ...entry, schoolId: entry.schoolId ?? null } });
  }
}
