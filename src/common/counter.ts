import { Prisma } from '@prisma/client';

/** Atomically increments a named counter and returns the new value. */
export async function nextValue(tx: Prisma.TransactionClient, key: string): Promise<number> {
  const row = await tx.counter.upsert({ where: { key }, create: { key, value: 1 }, update: { value: { increment: 1 } } });
  return row.value;
}

/** State-wide learner ID, e.g. OSN-26-000123. */
export async function nextLearnerId(tx: Prisma.TransactionClient, now = new Date()) {
  const yy = String(now.getFullYear()).slice(-2);
  const n = await nextValue(tx, `learner:${yy}`);
  return `OSN-${yy}-${String(n).padStart(6, '0')}`;
}

/** Admission number within a school, e.g. 2026/0042. */
export async function nextAdmissionNumber(tx: Prisma.TransactionClient, schoolId: string, now = new Date()) {
  const year = now.getFullYear();
  const n = await nextValue(tx, `admission:${schoolId}:${year}`);
  return `${year}/${String(n).padStart(4, '0')}`;
}
