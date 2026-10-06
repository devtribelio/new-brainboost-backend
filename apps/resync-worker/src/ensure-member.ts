/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Lazy member creation with incremental dedup — the resync-time counterpart of
 * migrate-members.ts (which did a one-shot union-find over all ~700k legacy members).
 *
 * Legacy still accepts registrations + brainboost purchases during cutover, so a member
 * referenced by a NEW brainboost row (enrollment / commission / tree / post) may not be
 * migrated yet. `ensureMember(legacyId)` materialises them on demand:
 *   - junk (@example.com, lxbfYeaa bot) / no-identity → not created (cached, returns undefined)
 *   - email/google/apple collides with an existing WINNER (legacyId set) → redirect
 *     this legacy id to that winner (persist member_redirect), return the winner
 *   - email/google/apple collides with a new-app placeholder (legacyId=null) → adopt it
 *   - collides on PHONE ONLY → never merged (PRD P0-5): a separate member is created
 *     without the phone (it stays with its holder) and the pair is logged for review.
 *     See identity-rules.ts.
 *   - otherwise → create a fresh member (frozen as its own winner)
 *
 * Existing winners are FROZEN (never re-ranked) — matches docs/legacy-resync-plan.md §6.
 * Mutates the in-run redirect / memberByLegacy maps so later syncers resolve the new id.
 */
import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import type { PrismaClient } from '@prisma/client';
import { normalizePhonePair } from '@bb/common/utils/phone.util';
import { detectPasswordAlgo } from '@bb/common/utils/password-algo.util';
import type { LegacyClient } from './legacy-db';
import { normalizeBankCode } from './bank-code';
import { bool, nonEmpty, toDate } from './util';
import { decideIdentityMatch, type IdentityKeys } from './identity-rules';

interface Deps {
  prisma: PrismaClient;
  legacy: LegacyClient;
  redirect: Map<number, number>;
  memberByLegacy: Map<number, string>;
  log: (msg: string) => void;
}

const COLS = `member_id, email, name, first_name, last_name, phone, password, image_url,
              biography, is_active, is_email_verified, is_phone_verified, google_id,
              sign_in_with_apple_id, date_register, is_deleted,
              bank_account_bank, bank_account_number, bank_account_name`;

const EXISTING_SELECT = {
  id: true,
  legacyId: true,
  bankAccountNumber: true,
  email: true,
  phone: true,
  googleSub: true,
  appleSub: true,
} as const;

const NO_PHONE = { phone: null, phoneCode: null, isPhoneVerified: false };

/** Prisma OR over the keys that prove one person (email / provider subs) — never phone. */
function strongKeysOr(k: Pick<IdentityKeys, 'email' | 'googleSub' | 'appleSub'>): any[] {
  const or: any[] = [];
  if (k.email) or.push({ email: k.email });
  if (k.googleSub) or.push({ googleSub: k.googleSub });
  if (k.appleSub) or.push({ appleSub: k.appleSub });
  return or;
}

function isJunk(name: string | null, rawEmail: string | null): boolean {
  if (rawEmail && /@example\.com$/i.test(rawEmail)) return true;
  if (name && /^lxbfYeaa/i.test(name)) return true;
  return false;
}

function fullNameOf(r: any): string | null {
  return (
    nonEmpty(r.name) ??
    ([nonEmpty(r.first_name), nonEmpty(r.last_name)].filter(Boolean).join(' ') || null)
  );
}

export function makeEnsureMember(deps: Deps) {
  const { prisma, legacy, redirect, memberByLegacy } = deps;
  const unresolvable = new Set<number>(); // legacy ids we've decided can't be created (junk/no-id/missing)
  const inflight = new Map<number, Promise<string | undefined>>(); // concurrency guard: one create per legacyId
  const newLegacyIds = new Set<number>(); // created/adopted this run → backfilled (kyc/tree/commissions/likes)
  let created = 0;
  let redirected = 0;
  let adopted = 0;
  let phoneOnlySeparated = 0;

  async function persistRedirect(loser: number, winner: number): Promise<void> {
    redirect.set(loser, winner);
    await prisma.memberRedirect.upsert({
      where: { loserLegacyId: loser },
      create: { loserLegacyId: loser, winnerLegacyId: winner },
      update: { winnerLegacyId: winner },
    });
  }

  async function create(legacyMemberId: number): Promise<string | undefined> {
    const [rows] = await legacy.query<RowDataPacket[]>(
      `SELECT ${COLS} FROM member WHERE member_id = ?`,
      [legacyMemberId],
    );
    const r = (rows as any[])[0];
    if (!r) {
      unresolvable.add(legacyMemberId);
      return undefined;
    }
    const rawEmail = nonEmpty(r.email);
    if (isJunk(nonEmpty(r.name), rawEmail)) {
      unresolvable.add(legacyMemberId);
      return undefined;
    }
    let email = rawEmail ? rawEmail.toLowerCase() : null;
    if (email && /@brainboost\.id$/i.test(email)) email = null; // generated → phone identity
    const rawPhone = nonEmpty(r.phone);
    const pair = rawPhone ? normalizePhonePair(rawPhone, '+62') : null;
    const phone = pair && pair.phone.length >= 6 ? pair.phone : null;
    const googleSub = nonEmpty(r.google_id);
    const appleSub = nonEmpty(r.sign_in_with_apple_id);
    if (!email && !phone && !googleSub && !appleSub) {
      unresolvable.add(legacyMemberId); // no identity
      return undefined;
    }

    // dedup: a strong key (email / provider sub) first, phone only as a fallback, so a
    // row that matches strongly is never shadowed by a different row holding the phone.
    const keys = { email, phone, googleSub, appleSub };
    const strongOr = strongKeysOr(keys);
    const existing =
      (strongOr.length
        ? await prisma.member.findFirst({ where: { OR: strongOr }, select: EXISTING_SELECT })
        : null) ??
      (phone ? await prisma.member.findFirst({ where: { phone }, select: EXISTING_SELECT }) : null);
    const decision = decideIdentityMatch(legacyMemberId, keys, existing);

    // legacy profile-level payout account (rarely filled; the KYC-sourced bank rides the
    // kyc syncer). Only offered when legacy actually has a number — never nulls anything.
    const bank = nonEmpty(r.bank_account_number)
      ? {
          bankCode: normalizeBankCode(r.bank_account_bank),
          bankAccountNumber: nonEmpty(r.bank_account_number),
          bankAccountName: nonEmpty(r.bank_account_name),
        }
      : null;

    const profile = {
      email,
      phone,
      phoneCode: phone ? pair!.phoneCode : null,
      googleSub,
      appleSub,
      fullName: fullNameOf(r),
      avatarUrl: nonEmpty(r.image_url),
      bio: nonEmpty(r.biography),
      isActive: bool(r.is_active) && !bool(r.is_deleted),
      isEmailVerified: email ? bool(r.is_email_verified) : false,
      isPhoneVerified: phone ? bool(r.is_phone_verified) : false,
    };

    if (decision === 'redirect') {
      // strong match with an existing winner → this legacy id is a dedup loser
      await persistRedirect(legacyMemberId, existing!.legacyId!);
      redirected += 1;
      return existing!.id;
    }
    if (decision === 'map') {
      // existing.legacyId === legacyMemberId (already migrated, race) → just map it
      memberByLegacy.set(legacyMemberId, existing!.id);
      return existing!.id;
    }
    if (decision === 'adopt' && existing) {
      // new-app placeholder → adopt it as this legacy member. updatedAt is set to the
      // SAME instant as legacySyncedAt so the members syncer's touch-gate
      // (updatedAt > legacySyncedAt) doesn't misread the fresh row as app-touched.
      const now = new Date();
      const adoptData: any = { legacyId: legacyMemberId, ...profile, legacySyncedAt: now, updatedAt: now };
      // fill bank only when the placeholder has none — never clobber an app-set account
      if (bank && existing.bankAccountNumber === null) Object.assign(adoptData, bank);
      try {
        await prisma.member.update({ where: { id: existing.id }, data: adoptData });
      } catch (err: any) {
        // Identity split: the placeholder matched on one unique field but ANOTHER member
        // owns a different one (e.g. matched by phone, email belongs to someone else).
        // Drop the conflicting field(s) — they stay owned by the other member — and retry
        // once. Without this catch a single split member aborts the whole calling syncer.
        const targets: string[] = Array.isArray(err?.meta?.target) ? err.meta.target.map(String) : [];
        if (err?.code !== 'P2002' || !targets.length) {
          unresolvable.add(legacyMemberId);
          return undefined;
        }
        if (targets.some((t) => t === 'legacyId' || t === 'legacy_id')) {
          // legacyId already taken (race) → map to whoever migrated it
          const winner = await prisma.member.findFirst({ where: { legacyId: legacyMemberId }, select: { id: true } });
          if (winner) {
            memberByLegacy.set(legacyMemberId, winner.id);
            return winner.id;
          }
          unresolvable.add(legacyMemberId);
          return undefined;
        }
        for (const t of targets) {
          if (t === 'email') {
            adoptData.email = null;
            adoptData.isEmailVerified = false;
          } else if (t === 'phone') {
            adoptData.phone = null;
            adoptData.phoneCode = null;
            adoptData.isPhoneVerified = false;
          } else if (t === 'googleSub' || t === 'google_sub') {
            adoptData.googleSub = null;
          } else if (t === 'appleSub' || t === 'apple_sub') {
            adoptData.appleSub = null;
          }
        }
        try {
          await prisma.member.update({ where: { id: existing.id }, data: adoptData });
          deps.log(`ensureMember: adopt conflict on ${targets.join(',')} for legacy ${legacyMemberId} — adopted without those fields`);
        } catch {
          unresolvable.add(legacyMemberId);
          return undefined;
        }
      }
      memberByLegacy.set(legacyMemberId, existing.id);
      newLegacyIds.add(legacyMemberId);
      adopted += 1;
      return existing.id;
    }
    if (decision === 'separate_without_phone') {
      // PRD P0-5: a shared phone alone is no proof of one person — never merge on it.
      // The number stays with its current holder; this legacy member gets its own row.
      deps.log(
        `ensureMember: phone-only collision legacy=${legacyMemberId} existingMember=${existing!.id} — created without phone (review)`,
      );
      phoneOnlySeparated += 1;
      return insertFresh(legacyMemberId, r, { ...profile, ...NO_PHONE }, bank);
    }
    return insertFresh(legacyMemberId, r, profile, bank);
  }

  async function insertFresh(
    legacyMemberId: number,
    r: any,
    profile: any,
    bank: Record<string, unknown> | null,
  ): Promise<string | undefined> {
    // updatedAt = legacySyncedAt (same instant) for the touch-gate, see adopt
    const legacyPassword = nonEmpty(r.password);
    const now = new Date();
    try {
      const row = await prisma.member.create({
        data: {
          legacyId: legacyMemberId,
          ...profile,
          ...(bank ?? {}),
          passwordHash: legacyPassword ?? `${randomUUID()}${randomUUID()}`,
          passwordAlgo: detectPasswordAlgo(legacyPassword),
          createdAt: toDate(r.date_register) ?? now,
          legacySyncedAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });
      memberByLegacy.set(legacyMemberId, row.id);
      newLegacyIds.add(legacyMemberId);
      created += 1;
      return row.id;
    } catch (err: any) {
      if (err?.code !== 'P2002') {
        unresolvable.add(legacyMemberId);
        return undefined;
      }
      // raced / dirty unique — a strong-key holder is the same person: redirect to it
      const strongOr = strongKeysOr(profile);
      const winner = strongOr.length
        ? await prisma.member.findFirst({ where: { OR: strongOr }, select: { id: true, legacyId: true } })
        : null;
      if (winner?.legacyId != null && winner.legacyId !== legacyMemberId) {
        await persistRedirect(legacyMemberId, winner.legacyId);
        redirected += 1;
        return winner.id;
      }
      if (winner) {
        memberByLegacy.set(legacyMemberId, winner.id);
        return winner.id;
      }
      if (profile.phone) {
        // only the phone collided (a holder appeared mid-run) — same rule as above
        deps.log(`ensureMember: phone-only collision legacy=${legacyMemberId} (race) — created without phone (review)`);
        phoneOnlySeparated += 1;
        return insertFresh(legacyMemberId, r, { ...profile, ...NO_PHONE }, bank);
      }
      unresolvable.add(legacyMemberId);
      return undefined;
    }
  }

  async function ensureMember(legacyId: number | null | undefined): Promise<string | undefined> {
    if (legacyId === null || legacyId === undefined) return undefined;
    const winner = redirect.get(legacyId) ?? legacyId;
    const known = memberByLegacy.get(winner);
    if (known) return known;
    if (unresolvable.has(legacyId)) return undefined;
    // concurrent callers for the same legacyId share one create() — without this, parallel
    // row-writes referencing the same un-migrated member would race into double-creates.
    const pending = inflight.get(legacyId);
    if (pending) return pending;
    const p = create(legacyId).finally(() => inflight.delete(legacyId));
    inflight.set(legacyId, p);
    return p;
  }

  ensureMember.stats = () => ({ created, redirected, adopted, phoneOnlySeparated });
  /** legacy ids materialised THIS run (created or adopted) — input for the backfill pass. */
  ensureMember.newLegacyIds = () => [...newLegacyIds];
  return ensureMember;
}
