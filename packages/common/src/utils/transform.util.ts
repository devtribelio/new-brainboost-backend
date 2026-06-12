import { Transform } from 'class-transformer';

/**
 * Canonical email form at the DTO edge: trimmed + lowercased.
 * Legacy register did `strtolower($email)` and the new login/social paths
 * lowercase before lookup — an email field that skips this stores mixed case
 * and becomes unfindable (`John@X.com` registered, `john@x.com` at login).
 */
export const NormalizeEmail = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));
