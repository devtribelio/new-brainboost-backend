/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Shared types for the legacy resync framework. See docs/legacy-resync-plan.md.
 */
import type { PrismaClient } from '@prisma/client';
import type { LegacyClient } from './legacy-db';
import type { ChangeEntry } from './change-log';

/** Narrow view of change-log.ts (fs-backed) so this module stays dependency-free. */
export interface ChangeLogSink {
  record(entry: ChangeEntry): void;
}

export interface Stats {
  scanned: number; // legacy rows examined
  upserted: number; // rows written (insert or update)
  skipped: number; // out of scope / unresolved / guard-blocked
  voided?: number; // commissions/affiliators deactivated
  errors: number; // per-row failures (run continues)
  /** Why rows were skipped (reason → count). Persisted in sync_state.lastStats. */
  skipReasons?: Record<string, number>;
  /** Up to a handful of example legacy PKs per reason, so a skip is actionable. */
  skipSamples?: Record<string, Array<number | string>>;
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
  /**
   * Persist a row that could not be processed (table `sync_issue`). Optional here because
   * hand-built contexts (identity.ts, one-off scripts) don't provide it; SyncerCtx makes it
   * required. Call it as `void ctx.recordIssue?.(...)` from helpers typed RunCtx.
   */
  recordIssue?(reason: string, legacyPk: number | string | null, detail?: string): Promise<void>;
}

/** Context for a single syncer: shared ctx + its watermark + checkpoint hook. */
export interface SyncerCtx extends RunCtx {
  /** stored watermark (max COALESCE(updated,created) seen) or null on first run. */
  since: string | null;
  /** legacy clock captured before this syncer's first query — the checkpoint ceiling. */
  runStart: Date;
  /**
   * Persist the watermark (from WatermarkTracker.result). null = nothing scanned → no-op.
   * Also a no-op in dry runs, and never moves forward across an unscanned `--since` gap.
   */
  checkpoint(watermark: string | null): Promise<void>;
  /**
   * Persist a row that could not be processed so it can be reconciled later (table
   * `sync_issue`, keyed `(syncer, legacyPk, reason)`, counts occurrences). Call this ONLY for
   * "needs attention" reasons — a row dropped for being out of scope is normal traffic and
   * would flood the table. No-op in dry runs; never throws (issue logging must not fail a
   * syncer).
   */
  recordIssue(reason: string, legacyPk: number | string | null, detail?: string): Promise<void>;
  /**
   * Opt-in CSV journal of row-level decisions (see change-log.ts), present only on a one-shot
   * run started with `--audit-csv`. The periodic worker never sets it. `record` is synchronous,
   * so it is safe to call from a `runConcurrent` callback.
   */
  changeLog?: ChangeLogSink;
}

export interface Syncer {
  name: string;
  /** Run the incremental sync; return final stats. Watermark is advanced via ctx.checkpoint. */
  run(ctx: SyncerCtx): Promise<Stats>;
}

/** Helper: the SQL fragment selecting rows changed since the watermark. */
export const WATERMARK_EXPR = 'COALESCE(`updated`, `created`)';
