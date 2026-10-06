import { describe, expect, it } from 'vitest';
import { WatermarkTracker } from '../src/util';

const d = (iso: string) => new Date(iso);
const RUN_START = d('2026-10-06T12:00:00.000Z');

describe('WatermarkTracker.result', () => {
  it('returns the max seen watermark when every row wrote', () => {
    const wm = new WatermarkTracker();
    wm.seen(d('2026-10-06T10:00:00Z'));
    wm.seen(d('2026-10-06T11:00:00Z'));
    wm.seen(d('2026-10-06T10:30:00Z'));
    expect(wm.result(RUN_START)).toBe('2026-10-06T11:00:00.000Z');
  });

  it('caps the checkpoint at the run start (a row changed mid-run is re-scanned)', () => {
    const wm = new WatermarkTracker();
    wm.seen(d('2026-10-06T11:00:00Z'));
    wm.seen(d('2026-10-06T12:05:00Z'));
    expect(wm.result(RUN_START)).toBe(RUN_START.toISOString());
  });

  it('holds the checkpoint one second before a failed row', () => {
    const wm = new WatermarkTracker();
    wm.seen(d('2026-10-06T10:00:00Z'));
    wm.failed(d('2026-10-06T10:30:00Z'));
    wm.seen(d('2026-10-06T11:00:00Z'));
    expect(wm.result(RUN_START)).toBe('2026-10-06T10:29:59.000Z');
  });

  it('holds on the EARLIEST failure, whatever order rows settle in', () => {
    const wm = new WatermarkTracker();
    wm.failed(d('2026-10-06T11:00:00Z'));
    wm.seen(d('2026-10-06T11:30:00Z'));
    wm.failed(d('2026-10-06T09:00:00Z'));
    wm.seen(d('2026-10-06T08:00:00Z'));
    expect(wm.result(RUN_START)).toBe('2026-10-06T08:59:59.000Z');
  });

  it('returns null when nothing was scanned (no checkpoint, stored value kept)', () => {
    expect(new WatermarkTracker().result(RUN_START)).toBeNull();
  });

  it('ignores a null watermark', () => {
    const wm = new WatermarkTracker();
    wm.seen(null);
    wm.failed(null);
    expect(wm.result(RUN_START)).toBeNull();
  });

  it('lets intentional skips advance (only failed() holds)', () => {
    const wm = new WatermarkTracker();
    wm.seen(d('2026-10-06T10:00:00Z')); // e.g. out of scope / guard-blocked
    wm.seen(d('2026-10-06T11:00:00Z'));
    expect(wm.result(RUN_START)).toBe('2026-10-06T11:00:00.000Z');
  });
});
