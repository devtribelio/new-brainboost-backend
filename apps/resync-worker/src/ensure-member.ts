/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Lazy member creation with incremental dedup — the resync-time counterpart of
 * migrate-members.ts (which did a one-shot union-find over all ~700k legacy members).
 *
 * Legacy still accepts registrations + brainboost purchases during cutover, so a member
 * referenced by a NEW brainboost row (enrollment / commission / tree / post) may not be
 * migrated yet. `ensureMember(legacyId)` materialises them on demand:
 *   - junk (@example.com, lxbfYeaa bot) / no-identity → not created (cached, returns undefined)
 *   - email/phone/google/apple collides with an existing WINNER (legacyId set) → redirect
 *     this legacy id to that winner (persist member_redirect), return the winner
 *   - collides with a new-app placeholder (legacyId=null) → adopt it (stamp legacyId + profile)
 *   - otherwise → create a fresh member (frozen as its own winner)
 *
 * Existing winners are FROZEN (never re-ranked) — matches docs/legacy-resync-plan.md §6.
 * Mutates the in-run redirect / memberByLegacy maps so later syncers resolve the new id.
 */
import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import type { PrismaClient } from '@prisma/client';
import { normalizePhonePair } from '@bb/common/utils/phone.util';
import type { LegacyClient } from './legacy-db';
import { bool, nonEmpty, toDate } from './util';

interface Deps {
  prisma: PrismaClient;
  legacy: LegacyClient;
  redirect: Map<number, number>;
  memberByLegacy: Map<number, string>;
  log: (msg: string) => void;
}

const COLS = `member_id, email, name, first_name, last_name, phone, password, image_url,
              biography, is_active, is_email_verified, is_phone_verified, google_id,
              sign_in_with_apple_id, date_register, is_deleted`;

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

    // dedup against any existing member on a unique identity field
    const or: any[] = [];
    if (email) or.push({ email });
    if (phone) or.push({ phone });
    if (googleSub) or.push({ googleSub });
    if (appleSub) or.push({ appleSub });
    const existing = or.length
      ? await prisma.member.findFirst({ where: { OR: or }, select: { id: true, legacyId: true } })
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

    if (existing) {
      if (existing.legacyId !== null && existing.legacyId !== legacyMemberId) {
        // collides with an existing winner → this legacy id is a dedup loser
        await persistRedirect(legacyMemberId, existing.legacyId);
        redirected += 1;
        return existing.id;
      }
      if (existing.legacyId === null) {
        // new-app placeholder → adopt it as this legacy member. updatedAt is set to the
        // SAME instant as legacySyncedAt so the members syncer's touch-gate
        // (updatedAt > legacySyncedAt) doesn't misread the fresh row as app-touched.
        const now = new Date();
        const adoptData: any = { legacyId: legacyMemberId, ...profile, legacySyncedAt: now, updatedAt: now };
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
      // existing.legacyId === legacyMemberId (already migrated, race) → just map it
      memberByLegacy.set(legacyMemberId, existing.id);
      return existing.id;
    }

    // fresh create — updatedAt = legacySyncedAt (same instant) for the touch-gate, see adopt
    const legacyPassword = nonEmpty(r.password);
    const now = new Date();
    try {
      const row = await prisma.member.create({
        data: {
          legacyId: legacyMemberId,
          ...profile,
          passwordHash: legacyPassword ?? `${randomUUID()}${randomUUID()}`,
          passwordAlgo: legacyPassword ? 'legacy' : 'social',
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
      if (err?.code === 'P2002' && or.length) {
        // raced / dirty unique — re-find and redirect to whoever holds it
        const winner = await prisma.member.findFirst({ where: { OR: or }, select: { id: true, legacyId: true } });
        if (winner?.legacyId != null && winner.legacyId !== legacyMemberId) {
          await persistRedirect(legacyMemberId, winner.legacyId);
          redirected += 1;
          return winner.id;
        }
        if (winner) {
          memberByLegacy.set(legacyMemberId, winner.id);
          return winner.id;
        }
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

  ensureMember.stats = () => ({ created, redirected, adopted });
  /** legacy ids materialised THIS run (created or adopted) — input for the backfill pass. */
  ensureMember.newLegacyIds = () => [...newLegacyIds];
  return ensureMember;
}
