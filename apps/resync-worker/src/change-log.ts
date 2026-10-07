/**
 * Append-only CSV journal of the row-level decisions a syncer made, so a repair run can be
 * reviewed (dry-run = the plan) and traced back if something was cancelled/granted wrongly.
 *
 * Opt-in and one-shot only: the change log is created only when the CLI passes `--audit-csv`
 * (`pnpm resync enrollments --dry-run --audit-csv=out.csv`). The periodic worker never sets it,
 * so production ticks write nothing.
 *
 * Writes are synchronous appends, buffered until 200 rows — safe under `runConcurrent`
 * (single-threaded, no await inside `record`).
 */
import { appendFileSync, existsSync } from 'node:fs';

export const CHANGE_LOG_HEADER = [
  'run_id',
  'syncer',
  'mode',
  'at',
  'action',
  'reason',
  'legacy_id',
  'member_legacy_id',
  'member_email',
  'member_phone',
  'course_legacy_id',
  'pg_enrollment_id',
  'before',
  'after',
  'detail',
].join(',');

export interface ChangeEntry {
  /** create | refresh | uncancel | repoint | skip | cancel | error */
  action: string;
  /** why: the syncer reason / guard that decided it. */
  reason?: string | null;
  legacyId?: number | string | null;
  memberLegacyId?: number | string | null;
  /** PII — only for the operator's review of the exported journal. */
  memberEmail?: string | null;
  /** PII — only for the operator's review of the exported journal. */
  memberPhone?: string | null;
  courseLegacyId?: number | string | null;
  pgEnrollmentId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  detail?: string | null;
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function changeLogLine(
  runId: string,
  syncer: string,
  mode: string,
  at: string,
  e: ChangeEntry,
): string {
  return [
    runId,
    syncer,
    mode,
    at,
    e.action,
    e.reason ?? '',
    e.legacyId ?? '',
    e.memberLegacyId ?? '',
    e.memberEmail ?? '',
    e.memberPhone ?? '',
    e.courseLegacyId ?? '',
    e.pgEnrollmentId ?? '',
    e.before ? JSON.stringify(e.before) : '',
    e.after ? JSON.stringify(e.after) : '',
    e.detail ?? '',
  ]
    .map(csvCell)
    .join(',');
}

/** `--audit-csv` value → the file to write. Empty or a directory → a default name per syncer. */
export function auditPathFor(target: string, syncer: string, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  if (!target) return `resync-audit-${syncer}-${stamp}.csv`;
  if (target.endsWith('/')) return `${target}resync-audit-${syncer}-${stamp}.csv`;
  return target;
}

export class ChangeLog {
  private buffer: string[] = [];
  private seeded = false;
  private rows = 0;

  constructor(
    readonly path: string,
    private readonly syncer: string,
    private readonly runId: string,
    private readonly dryRun: boolean,
  ) {}

  get count(): number {
    return this.rows;
  }

  record(e: ChangeEntry): void {
    if (!this.seeded) {
      if (!existsSync(this.path)) this.buffer.push(CHANGE_LOG_HEADER);
      this.seeded = true;
    }
    this.buffer.push(
      changeLogLine(this.runId, this.syncer, this.dryRun ? 'dry-run' : 'apply', new Date().toISOString(), e),
    );
    this.rows += 1;
    if (this.buffer.length >= 200) this.flush();
  }

  flush(): void {
    if (!this.buffer.length) return;
    appendFileSync(this.path, this.buffer.join('\n') + '\n');
    this.buffer = [];
  }

  close(): void {
    this.flush();
  }
}
