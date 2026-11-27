/**
 * Creates the first Ministry administrator, if there isn't one yet.
 *
 *   SEED_ADMIN_NAME="Ministry Admin" SEED_ADMIN_EMAIL=admin@example.gov.ng SEED_ADMIN_PASSWORD=... npm run db:seed
 *
 * SEED_ADMIN_PASSWORD is a temporary password that you choose and pass on to the administrator yourself; it is never
 * printed or logged. The administrator must change it at first sign-in.
 */
import { PrismaClient, Role } from '@prisma/client';
import { normaliseEmail, normalisePhone } from '../src/common/identity';
import { hashPassword } from '../src/common/password';

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.count({ where: { role: Role.MINISTRY_ADMIN } });
    if (existing > 0) {
      console.log('A Ministry administrator already exists. Nothing to do.');
      return;
    }
    const email = process.env.SEED_ADMIN_EMAIL ? normaliseEmail(process.env.SEED_ADMIN_EMAIL) : null;
    const phone = process.env.SEED_ADMIN_PHONE ? normalisePhone(process.env.SEED_ADMIN_PHONE) : null;
    if (!email && !phone) throw new Error('Set SEED_ADMIN_EMAIL or SEED_ADMIN_PHONE.');
    const tempPassword = process.env.SEED_ADMIN_PASSWORD ?? '';
    if ([...tempPassword].length < 12) throw new Error('Set SEED_ADMIN_PASSWORD to a temporary password of at least 12 characters.');
    const user = await prisma.user.create({
      data: {
        fullName: process.env.SEED_ADMIN_NAME || 'Ministry Administrator',
        email, phone, role: Role.MINISTRY_ADMIN,
        passwordHash: await hashPassword(tempPassword), mustChangePassword: true,
      },
    });
    await prisma.auditLog.create({ data: { action: 'user.created', targetType: 'user', targetId: user.id, meta: { role: Role.MINISTRY_ADMIN, via: 'seed' } } });
    console.log('Ministry administrator created.');
    console.log(`  Sign in with: ${email ?? phone}`);
    console.log('  Temporary password: the one set in SEED_ADMIN_PASSWORD');
    console.log('  You will be asked to choose a new password at first sign-in.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
