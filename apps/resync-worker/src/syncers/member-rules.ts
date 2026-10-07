/**
 * Per-field ownership rules for the members syncer (docs/legacy-resync-plan.md §6).
 *
 * The gate reads the app-edit markers (profileUpdatedAt / passwordUpdatedAt), set ONLY by
 * member-initiated app edits — never `updatedAt`, which every Prisma write bumps (push
 * counters, lastActiveAt, the resync's own writes) and so read nearly every row as touched.
 */
import { detectPasswordAlgo } from '@bb/common/utils/password-algo.util';

export interface MemberSyncCurrent {
  profileUpdatedAt: Date | null;
  passwordUpdatedAt: Date | null;
  scheduledDeletionAt: Date | null;
}

export interface MemberSyncLegacy {
  fullName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  password: string | null; // already nonEmpty()'d
  isActive: boolean; // is_active && !is_deleted
}

export interface MemberSyncPlan {
  profile: { fullName: string | null; avatarUrl: string | null; bio: string | null } | null;
  password: { hash: string; algo: string } | null;
  isActive: boolean | null; // null = leave as is
}

export function planMemberSync(current: MemberSyncCurrent, legacy: MemberSyncLegacy): MemberSyncPlan {
  return {
    profile:
      current.profileUpdatedAt === null
        ? { fullName: legacy.fullName, avatarUrl: legacy.avatarUrl, bio: legacy.bio }
        : null,
    // A NULL legacy password never overwrites — it would clobber a real hash.
    password:
      current.passwordUpdatedAt === null && legacy.password
        ? { hash: legacy.password, algo: detectPasswordAlgo(legacy.password) }
        : null,
    // Follow legacy both ways, except never reactivate a member who asked the app to
    // delete their account (that flow deactivates; a legacy is_active=1 must not undo it).
    isActive: legacy.isActive && current.scheduledDeletionAt !== null ? null : legacy.isActive,
  };
}
