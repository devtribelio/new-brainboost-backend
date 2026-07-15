import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

/**
 * Seeds (idempotently) the external tester account used for app-store review.
 * The account logs in with a normal password; OTP-gated flows it hits (register,
 * re-verify, delete-account) are satisfied by the fixed code 000000 — but ONLY
 * once this identifier is added to TEST_ACCOUNT_IDENTIFIERS and
 * TEST_ACCOUNT_ENABLED=true. See docs/specs/test-account.md.
 *
 * Env:
 *   TEST_ACCOUNT_SEED_PASSWORD  (required)
 *   TEST_ACCOUNT_SEED_EMAIL     (email and/or phone — at least one required)
 *   TEST_ACCOUNT_SEED_PHONE     (national digits, no leading 0 / dial code)
 *   TEST_ACCOUNT_SEED_NAME      (optional, default "External Tester")
 *   TEST_ACCOUNT_SEED_USERNAME  (optional)
 */
async function main() {
  const email = (process.env.TEST_ACCOUNT_SEED_EMAIL ?? '').trim().toLowerCase() || null;
  const phone = (process.env.TEST_ACCOUNT_SEED_PHONE ?? '').trim() || null;
  const password = process.env.TEST_ACCOUNT_SEED_PASSWORD ?? '';
  const fullName = process.env.TEST_ACCOUNT_SEED_NAME ?? 'External Tester';
  const username = (process.env.TEST_ACCOUNT_SEED_USERNAME ?? '').trim() || null;

  if (!password || (!email && !phone)) {
    console.error(
      'Set TEST_ACCOUNT_SEED_PASSWORD and at least one of ' +
        'TEST_ACCOUNT_SEED_EMAIL / TEST_ACCOUNT_SEED_PHONE. Aborting.',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const passwordHash = await bcrypt.hash(password, 10);

  const fields = {
    passwordHash,
    passwordAlgo: 'bcrypt',
    fullName,
    isActive: true,
    isEmailVerified: Boolean(email),
    isPhoneVerified: Boolean(phone),
    ...(username ? { username } : {}),
  };

  // Upsert by whichever unique identifier we have (email preferred).
  const where = email ? { email } : { phone: phone! };
  const member = await prisma.member.upsert({
    where,
    create: { email, phone, ...fields },
    update: fields,
  });

  console.log(
    `Seeded test account (id=${member.id}, email=${member.email ?? '-'}, phone=${member.phone ?? '-'})`,
  );
  console.log(
    'Next: add this email/phone to TEST_ACCOUNT_IDENTIFIERS and set ' +
      'TEST_ACCOUNT_ENABLED=true so OTP 000000 is accepted for it.',
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
