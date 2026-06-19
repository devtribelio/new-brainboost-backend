/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * Backfill the affiliate upline tree onto migrated members.
 *
 *   pnpm tsx scripts/backfill-affiliate-tree.ts
 *
 * Without this, migrated members have no inviter chain and the commission engine
 * (commitCommissionsForPayment) early-returns "no inviter" — so NO commissions fire.
 *
 * Source of truth (legacy MariaDB):
 *   - member_network.parent_id  -> a member_network_id (NODE pk), NOT a member_id.
 *     Resolve parent NODE -> its member_id -> new Member.id to get inviterId.
 *   - member_network.affiliate_based -> Member.affiliateBased (GROWTH/PERFORMANCE/INACTIVE).
 *   - member.affiliator_code -> Member.affiliateCode (preserves existing marketing links).
 *
 * Idempotent: re-running just re-sets the same values. Run on the server (or via tunnel).
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import type { RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const REDIRECT_PATH = 'scripts/member-redirect.json';

/**
 * loser legacy member_id -> winner legacy member_id, written by migrate-members.ts.
 * Dedup drops duplicate accounts; an inviter that was a dropped loser must be
 * re-pointed to the surviving winner, else the downline's inviterId dangles to null.
 */
function loadRedirect(): Map<number, number> {
  const map = new Map<number, number>();
  if (!existsSync(REDIRECT_PATH)) return map;
  const raw = JSON.parse(readFileSync(REDIRECT_PATH, 'utf8')) as Record<string, number>;
  for (const [loser, winner] of Object.entries(raw)) map.set(Number(loser), Number(winner));
  return map;
}

const prisma = new PrismaClient({ log: ['warn', 'error'] });
const CHUNK = Number.parseInt(process.env.BACKFILL_CHUNK ?? '200', 10);
const CONCURRENCY = Number.parseInt(process.env.BACKFILL_CONCURRENCY ?? '25', 10);

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function nonEmpty(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** legacy Member.member_id -> new Member.id (uuid) */
async function buildMemberMap(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  let cursor = 0;
  for (;;) {
    const rows = await prisma.member.findMany({
      where: { legacyId: { gt: cursor } },
      select: { id: true, legacyId: true },
      orderBy: { legacyId: 'asc' },
      take: 20000,
    });
    if (rows.length === 0) break;
    for (const r of rows) if (r.legacyId !== null) map.set(r.legacyId, r.id);
    cursor = rows[rows.length - 1].legacyId as number;
  }
  return map;
}

/** legacy member_network.member_network_id -> member_id */
async function buildNodeMap(legacy: Awaited<ReturnType<typeof connectLegacyDb>>): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  let cursor = 0;
  for (;;) {
    const [rows] = await legacy.query<RowDataPacket[]>(
      'SELECT member_network_id, member_id FROM member_network WHERE member_network_id > ? ORDER BY member_network_id ASC LIMIT 50000',
      [cursor],
    );
    if (rows.length === 0) break;
    for (const r of rows as any[]) {
      if (r.member_id != null) map.set(Number(r.member_network_id), Number(r.member_id));
    }
    cursor = Number((rows[rows.length - 1] as any).member_network_id);
  }
  return map;
}

interface Update {
  id: string;
  inviterId: string | null;
  affiliateBased: string;
  affiliateCode: string | null;
}

async function applyRow(u: Update): Promise<'ok' | 'ok-no-code' | 'fail'> {
  const base = { inviterId: u.inviterId, affiliateBased: u.affiliateBased };
  try {
    await prisma.member.update({
      where: { id: u.id },
      data: u.affiliateCode ? { ...base, affiliateCode: u.affiliateCode } : base,
    });
    return 'ok';
  } catch (e: any) {
    if (e?.code === 'P2002' && u.affiliateCode) {
      // affiliateCode collision — keep tree fields, drop the code.
      try {
        await prisma.member.update({ where: { id: u.id }, data: base });
        return 'ok-no-code';
      } catch {
        return 'fail';
      }
    }
    return 'fail';
  }
}

async function flush(buffer: Update[], stats: { ok: number; noCode: number; fail: number }) {
  for (let i = 0; i < buffer.length; i += CONCURRENCY) {
    const slice = buffer.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map(applyRow));
    for (const r of results) {
      if (r === 'ok') stats.ok++;
      else if (r === 'ok-no-code') stats.noCode++;
      else stats.fail++;
    }
  }
  buffer.length = 0;
}

async function main() {
  const legacy = await connectLegacyDb({ dateStrings: false });
  log('connected to legacy mariadb');
  try {
    log('building member map (legacy member_id -> uuid)');
    const memberMap = await buildMemberMap();
    log(`member map: ${memberMap.size}`);

    log('building network node map (member_network_id -> member_id)');
    const nodeMap = await buildNodeMap(legacy);
    log(`node map: ${nodeMap.size}`);

    const redirect = loadRedirect();
    log(`redirect map (loser->winner): ${redirect.size}`);

    const stats = { ok: 0, noCode: 0, fail: 0, skipped: 0, scanned: 0 };
    const buffer: Update[] = [];
    let cursor = 0;
    for (;;) {
      const [rows] = await legacy.query<RowDataPacket[]>(
        `SELECT mn.member_network_id, mn.member_id, mn.parent_id, mn.affiliate_based, m.affiliator_code
         FROM member_network mn JOIN member m ON m.member_id = mn.member_id
         WHERE mn.member_network_id > ? ORDER BY mn.member_network_id ASC LIMIT 5000`,
        [cursor],
      );
      if (rows.length === 0) break;
      for (const r of rows as any[]) {
        stats.scanned++;
        const newId = memberMap.get(Number(r.member_id));
        if (!newId) {
          stats.skipped++;
          continue;
        }
        let inviterId: string | null = null;
        if (r.parent_id != null) {
          const inviterLegacyId = nodeMap.get(Number(r.parent_id));
          if (inviterLegacyId != null) {
            // Redirect a dropped-duplicate inviter to its surviving winner.
            const canonical = redirect.get(inviterLegacyId) ?? inviterLegacyId;
            inviterId = memberMap.get(canonical) ?? null;
          }
        }
        buffer.push({
          id: newId,
          inviterId,
          affiliateBased: nonEmpty(r.affiliate_based) ?? 'PERFORMANCE',
          affiliateCode: nonEmpty(r.affiliator_code),
        });
      }
      cursor = Number((rows[rows.length - 1] as any).member_network_id);
      if (buffer.length >= CHUNK) {
        await flush(buffer, stats);
        log(`progress: scanned=${stats.scanned} ok=${stats.ok} ok-no-code=${stats.noCode} skipped=${stats.skipped} fail=${stats.fail}`);
      }
    }
    await flush(buffer, stats);
    log(`DONE scanned=${stats.scanned} ok=${stats.ok} ok-no-code=${stats.noCode} skipped=${stats.skipped} fail=${stats.fail}`);
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
