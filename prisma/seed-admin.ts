import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

async function main() {
  const email = (process.env.ADMIN_SEED_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.ADMIN_SEED_PASSWORD ?? '';
  const fullName = process.env.ADMIN_SEED_NAME ?? 'Super Admin';

  if (!email || !password) {
    console.error(
      'ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD must be set. Aborting seed.',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const passwordHash = await bcrypt.hash(password, 10);

  const admin = await prisma.admin.upsert({
    where: { email },
    create: {
      email,
      fullName,
      passwordHash,
      role: 'SUPERADMIN',
      isActive: true,
    },
    update: {
      fullName,
      passwordHash,
      role: 'SUPERADMIN',
      isActive: true,
    },
  });

  console.log(`Seeded admin ${admin.email} (id=${admin.id}, role=${admin.role})`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
