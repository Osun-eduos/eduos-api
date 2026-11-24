import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export async function currentSession(db: Prisma.TransactionClient) {
  return db.academicSession.findFirst({ where: { isCurrent: true } });
}

export async function requireCurrentSession(db: Prisma.TransactionClient) {
  const s = await currentSession(db);
  if (!s) throw new BadRequestException('The Ministry has not set the current academic session yet.');
  return s;
}
