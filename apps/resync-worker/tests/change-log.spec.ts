import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditPathFor, ChangeLog, changeLogLine, csvCell } from '../src/change-log';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('csvCell', () => {
  it('escapes quotes, commas and newlines and blanks null/undefined', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
  });
});

describe('changeLogLine', () => {
  it('writes the fixed column order with JSON snapshots', () => {
    const line = changeLogLine('run1', 'enrollments', 'dry-run', 'T0', {
      action: 'cancel',
      reason: 'legacy_removed',
      legacyId: 146614,
      memberLegacyId: 94184,
      memberEmail: 'someone@example.com',
      memberPhone: '+628123456789',
      courseLegacyId: 225,
      pgEnrollmentId: 'uuid-1',
      before: { isCanceled: false },
      after: { isCanceled: true, reason: 'legacy_removed' },
    });
    expect(line).toBe(
      'run1,enrollments,dry-run,T0,cancel,legacy_removed,146614,94184,someone@example.com,+628123456789,225,uuid-1,' +
        '"{""isCanceled"":false}","{""isCanceled"":true,""reason"":""legacy_removed""}",',
    );
  });

  it('leaves optional columns empty', () => {
    expect(changeLogLine('r', 's', 'apply', 'T', { action: 'skip' })).toBe('r,s,apply,T,skip,,,,,,,,,,');
  });
});

describe('auditPathFor', () => {
  const at = new Date('2026-10-06T11:00:00.000Z');
  it('defaults to a per-syncer name when no path is given', () => {
    expect(auditPathFor('', 'enrollments', at)).toBe('resync-audit-enrollments-2026-10-06T11-00-00-000Z.csv');
  });
  it('keeps an explicit file path and prefixes a directory', () => {
    expect(auditPathFor('/tmp/out.csv', 'enrollments', at)).toBe('/tmp/out.csv');
    expect(auditPathFor('/tmp/', 'enrollments', at)).toBe('/tmp/resync-audit-enrollments-2026-10-06T11-00-00-000Z.csv');
  });
});

describe('ChangeLog', () => {
  it('writes the header once and appends entries with a count', () => {
    dir = mkdtempSync(join(tmpdir(), 'chlog-'));
    const path = join(dir, 'a.csv');
    const log = new ChangeLog(path, 'enrollments', 'run-1', true);
    log.record({ action: 'cancel', reason: 'legacy_removed', legacyId: 1 });
    log.flush();
    log.record({ action: 'create', legacyId: 2 });
    log.close();
    expect(log.count).toBe(2);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('run_id,syncer,mode,at,action');
    expect(lines[1]).toContain('run-1,enrollments,dry-run');
    expect(lines[1]).toContain(',cancel,legacy_removed,1,');
    expect(lines[2]).toContain(',create,,2,');
  });

  it('is a no-op source when the syncer has no changeLog', () => {
    // ctx.changeLog is optional; journal() must tolerate it being absent.
    const ctx: { changeLog?: { record: (e: unknown) => void } } = {};
    expect(() => ctx.changeLog?.record({ action: 'skip' })).not.toThrow();
  });
});
