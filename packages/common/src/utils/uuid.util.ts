import { BadRequestException } from '@bb/common/exceptions';

// Repo PKs are UUID v7 (`@db.Uuid`). FE often passes legacyId/code instead.
// Guard `findUnique({ where: { id } })` so a non-UUID input fails cleanly
// instead of throwing a Prisma P2023 ("Error creating UUID") 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(input: string | null | undefined): input is string {
  return typeof input === 'string' && UUID_RE.test(input);
}

// Throws BadRequestException (400) when input is not a UUID. Use before
// passing FE input straight into a Uuid `where: { id }` lookup.
export function assertUuid(input: string | null | undefined): asserts input is string {
  if (!isUuid(input)) {
    throw new BadRequestException('Invalid id format');
  }
}
