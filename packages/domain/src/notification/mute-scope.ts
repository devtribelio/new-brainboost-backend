import { prisma } from '@bb/db';
import { badRequest, notFound, ERROR_CODES } from '@bb/common/exceptions';
import { assertUuid } from '@bb/common/utils/uuid.util';

export const MuteScope = {
  Post: 'post',
  Network: 'network',
  Topic: 'topic',
} as const;

export type MuteScope = (typeof MuteScope)[keyof typeof MuteScope];

const MUTE_SCOPES: readonly string[] = Object.values(MuteScope);

export function isMuteScope(scope: string): scope is MuteScope {
  return MUTE_SCOPES.includes(scope);
}

export function assertMuteScope(scope: string): asserts scope is MuteScope {
  if (!isMuteScope(scope)) {
    throw badRequest(ERROR_CODES.NOTIFICATION_SCOPE_INVALID);
  }
}

const NOT_FOUND_CODE = {
  [MuteScope.Post]: ERROR_CODES.POST_NOT_FOUND,
  [MuteScope.Network]: ERROR_CODES.NETWORK_NOT_FOUND,
  [MuteScope.Topic]: ERROR_CODES.TOPIC_NOT_FOUND,
} as const;

function findByLegacyId(scope: MuteScope, legacyId: number) {
  const select = { id: true };
  if (scope === MuteScope.Post) return prisma.post.findUnique({ where: { legacyId }, select });
  if (scope === MuteScope.Topic) return prisma.topic.findUnique({ where: { legacyId }, select });
  return prisma.network.findUnique({ where: { legacyId }, select });
}

// notification_mutes.ref_id is `@db.Uuid`, but the mobile client passes legacyId
// ints for posts/topics/networks everywhere else (every one of those modules has
// a resolveByAnyId). Without this the raw int reaches Prisma and surfaces as a
// P2023 500 instead of muting anything.
export async function resolveMuteRefId(scope: MuteScope, refId: string): Promise<string> {
  const legacyId = Number.parseInt(refId, 10);
  if (Number.isFinite(legacyId) && refId === String(legacyId)) {
    const row = await findByLegacyId(scope, legacyId);
    if (!row) throw notFound(NOT_FOUND_CODE[scope]);
    return row.id;
  }
  assertUuid(refId);
  return refId;
}
