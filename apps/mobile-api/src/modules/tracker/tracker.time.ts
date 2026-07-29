import { addDays } from '@bb/common/utils/wib.util';

/**
 * WIB day math for the listening tracker.
 *
 * The general helpers are shared with the notification digest job, so they live
 * in `@bb/common/utils/wib.util` and are re-exported here — tracker code keeps
 * importing from this module, and there is exactly one implementation.
 */
export { toLocalDayWIB, dayKey, addDays } from '@bb/common/utils/wib.util';

/**
 * Monday (WIB) of the week containing `day` (a UTC-midnight WIB day).
 * Used as the anchor for weekly-recap windows and week numbering.
 */
export function weekStartMondayWIB(day: Date): Date {
  // getUTCDay(): 0=Sun..6=Sat. Days to subtract to reach Monday.
  const dow = day.getUTCDay();
  const back = (dow + 6) % 7;
  return addDays(day, -back);
}
