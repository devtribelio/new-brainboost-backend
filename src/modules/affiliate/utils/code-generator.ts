import { customAlphabet } from 'nanoid';
import { prisma } from '@/config/prisma';
import { AFFILIATE_CODE_LENGTH, PROGRAM_CODE_LENGTH, CODE_ALPHABET } from '../constants';

const generateAffiliateCodeRaw = customAlphabet(CODE_ALPHABET, AFFILIATE_CODE_LENGTH);
const generateProgramCodeRaw = customAlphabet(CODE_ALPHABET, PROGRAM_CODE_LENGTH);

const MAX_RETRIES = 5;

/**
 * Assign unique 6-char affiliateCode to a member. Retry on collision.
 */
export async function assignMemberAffiliateCode(memberId: string): Promise<string> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const code = generateAffiliateCodeRaw();
    try {
      await prisma.member.update({ where: { id: memberId }, data: { affiliateCode: code } });
      return code;
    } catch (e) {
      if (isPrismaUniqueViolation(e) && i < MAX_RETRIES - 1) continue;
      throw e;
    }
  }
  throw new Error(`Could not generate unique affiliateCode after ${MAX_RETRIES} retries`);
}

/**
 * Generate unique 8-char program code (no DB write — caller decides where to persist).
 * Retry until DB-level uniqueness is satisfied via the provided checker.
 */
export async function generateUniqueProgramCode(
  isUnique: (candidate: string) => Promise<boolean>,
): Promise<string> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const code = generateProgramCodeRaw();
    if (await isUnique(code)) return code;
  }
  throw new Error(`Could not generate unique program code after ${MAX_RETRIES} retries`);
}

function isPrismaUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002';
}
