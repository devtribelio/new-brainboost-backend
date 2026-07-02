/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Shared types for the legacy resync framework. See docs/legacy-resync-plan.md.
 */
import type { PrismaClient } from '@prisma/client';
import type { LegacyClient } from './legacy-db';

export interface Stats {
  scanned: number; // legacy rows examined
  upserted: number; // rows written (insert or update)
  skipped: number; // out of scope / unresolved / guard-blocked
  voided?: number; // commissions/affiliators deactivated
  errors: number; // per-row failures (run continues)
}

export function emptyStats(): Stats {
  return { scanned: 0, upserted: 0, skipped: 0, errors: 0 };
}

/** Shared per-run context, built once and handed to every syncer. */
export interface RunCtx {
  prisma: PrismaClient;
  legacy: LegacyClient;
  /** loser legacyId -> winner legacyId (from member_redirect). */
  redirect: Map<number, number>;
  /** new Member.uuid by legacyId (winners only). */
  memberByLegacy: Map<number, string>;
  /** redirect-then-lookup: legacy member id -> new uuid (undefined if out of scope). */
  resolveMember(legacyId: number | null | undefined): string | undefined;
  /**
   * Like resolveMember, but if the legacy member isn't migrated yet it is CREATED on the
   * spot (with email/phone/sub dedup against existing members) and the in-run maps + the
   * member_redirect table are updated. Returns undefined only if the legacy member is junk
   * / has no identity / doesn't exist. Used by syncers whose rows are already brainboost-
   * scoped (a referenced member is in scope by definition). See docs/legacy-resync-plan.md §6.
   */
  ensureMember(legacyId: number | null | undefined): Promise<string | undefined>;
  batchSize: number;
  dryRun: boolean;
  log: (msg: string) => void;
}

/** Context for a single syncer: shared ctx + its watermark + checkpoint hook. */
export interface SyncerCtx extends RunCtx {
  /** stored watermark (max COALESCE(updated,created) seen) or null on first run. */
  since: string | null;
  /** persist the watermark mid-run so an ECONNRESET resumes instead of restarting. */
  checkpoint(watermark: string): Promise<void>;
}

export interface Syncer {
  name: string;
  /** Run the incremental sync; return final stats. Watermark is advanced via ctx.checkpoint. */
  run(ctx: SyncerCtx): Promise<Stats>;
}

/** Helper: the SQL fragment selecting rows changed since the watermark. */
export const WATERMARK_EXPR = 'COALESCE(`updated`, `created`)';
