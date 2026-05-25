/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * One-shot data migration: legacy MariaDB (tribelio_db) -> new Postgres (bb).
 * Idempotent via `legacyId` columns. Run multiple times safely.
 *
 *   pnpm tsx scripts/migrate-from-legacy.ts [phase[,phase...]]
 *
 * Phases (run in order if not specified):
 *   master | members | networks | topics | network-members |
 *   posts | comments | post-likes | comment-likes | products | reports
 */
import 'dotenv/config';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import { connectLegacyDb } from './legacy-db';

const BATCH = Number.parseInt(process.env.MIGRATE_BATCH ?? '1000', 10);
const PROGRESS_EVERY = 5;

const prisma = new PrismaClient({ log: ['warn', 'error'] });

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function s(value: any, max?: number): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value);
  if (str.length === 0) return null;
  return max ? str.slice(0, max) : str;
}

function nonEmpty(value: any): string | null {
  const v = s(value);
  return v && v.trim() !== '' ? v : null;
}

function bool(value: any): boolean {
  if (value === 1 || value === true || value === '1') return true;
  return false;
}

function date(value: any): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function* paginate<T extends RowDataPacket>(
  legacy: Connection,
  baseSql: string,
  pkColumn: string,
  pageSize = 5000,
): AsyncGenerator<T[]> {
  let cursor = 0;
  while (true) {
    const sql = `${baseSql} AND ${pkColumn} > ? ORDER BY ${pkColumn} ASC LIMIT ?`;
    const [rows] = (await legacy.query(sql, [cursor, pageSize])) as [T[], unknown];
    if (rows.length === 0) return;
    yield rows;
    cursor = (rows[rows.length - 1] as any)[pkColumn] as number;
  }
}

async function buildMap(
  delegate: { findMany: (args: any) => Promise<any[]> },
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  let cursor = 0;
  while (true) {
    const rows = await delegate.findMany({
      where: { legacyId: { gt: cursor } },
      select: { id: true, legacyId: true },
      orderBy: { legacyId: 'asc' },
      take: 20000,
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.legacyId !== null) map.set(r.legacyId as number, r.id as string);
    }
    cursor = rows[rows.length - 1].legacyId as number;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function migrateCountries(legacy: Connection) {
  log('countries: fetching');
  const [rows] = (await legacy.query(
    `SELECT country_id, name, code FROM country WHERE deleted IS NULL`,
  )) as [RowDataPacket[], unknown];
  let inserted = 0;
  for (const r of rows as any[]) {
    const name = nonEmpty(r.name);
    if (!name) continue;
    await prisma.country.upsert({
      where: { legacyId: r.country_id },
      create: { legacyId: r.country_id, name, code: nonEmpty(r.code) },
      update: { name, code: nonEmpty(r.code) },
    });
    inserted++;
  }
  log(`countries: ${inserted}/${rows.length} done`);
}

async function migrateProvinces(legacy: Connection) {
  log('provinces: fetching');
  const countryMap = await buildMap(prisma.country);
  const [rows] = (await legacy.query(
    `SELECT province_id, country_id, name FROM province`,
  )) as [RowDataPacket[], unknown];
  let inserted = 0,
    skipped = 0;
  for (const r of rows as any[]) {
    const name = nonEmpty(r.name);
    const countryId = countryMap.get(r.country_id);
    if (!name || !countryId) {
      skipped++;
      continue;
    }
    await prisma.province.upsert({
      where: { legacyId: r.province_id },
      create: { legacyId: r.province_id, name, countryId },
      update: { name, countryId },
    });
    inserted++;
  }
  log(`provinces: ${inserted} inserted, ${skipped} skipped`);
}

async function migrateCities(legacy: Connection) {
  log('cities: fetching');
  const provMap = await buildMap(prisma.province);
  const [rows] = (await legacy.query(
    `SELECT city_id, province_id, name FROM city WHERE deleted IS NULL`,
  )) as [RowDataPacket[], unknown];
  let inserted = 0,
    skipped = 0;
  for (const batch of chunk(rows as any[], BATCH)) {
    const data = batch
      .map((r) => {
        const name = nonEmpty(r.name);
        const provinceId = provMap.get(r.province_id);
        if (!name || !provinceId) {
          skipped++;
          return null;
        }
        return { legacyId: r.city_id as number, name, provinceId };
      })
      .filter((x): x is { legacyId: number; name: string; provinceId: string } => x !== null);
    if (data.length) {
      await prisma.city.createMany({ data, skipDuplicates: true });
      inserted += data.length;
    }
  }
  log(`cities: ${inserted} inserted, ${skipped} skipped`);
}

async function migrateDistricts(legacy: Connection) {
  log('districts: fetching');
  const cityMap = await buildMap(prisma.city);
  const [rows] = (await legacy.query(
    `SELECT district_id, city_id, name FROM district WHERE deleted IS NULL`,
  )) as [RowDataPacket[], unknown];
  let inserted = 0,
    skipped = 0;
  for (const batch of chunk(rows as any[], BATCH)) {
    const data = batch
      .map((r) => {
        const name = nonEmpty(r.name);
        const cityId = cityMap.get(r.city_id);
        if (!name || !cityId) {
          skipped++;
          return null;
        }
        return { legacyId: r.district_id as number, name, cityId };
      })
      .filter((x): x is { legacyId: number; name: string; cityId: string } => x !== null);
    if (data.length) {
      await prisma.district.createMany({ data, skipDuplicates: true });
      inserted += data.length;
    }
  }
  log(`districts: ${inserted} inserted, ${skipped} skipped`);
}

async function migrateReportCategories(legacy: Connection) {
  log('report-categories: fetching');
  const [rows] = (await legacy.query(
    `SELECT member_report_member_category_id AS id, name, status FROM member_report_member_category WHERE status=1`,
  )) as [RowDataPacket[], unknown];
  for (const r of rows as any[]) {
    const name = nonEmpty(r.name);
    if (!name) continue;
    await prisma.reportCategory.upsert({
      where: { legacyId: r.id },
      create: { legacyId: r.id, name, isActive: true },
      update: { name },
    });
  }
  log(`report-categories: ${rows.length} done`);
}

async function migrateBanners(legacy: Connection) {
  log('banners: fetching');
  const [rows] = (await legacy.query(
    `SELECT tribeversity_banner_id, client, link_url, is_active FROM tribeversity_banner WHERE status=1`,
  )) as [RowDataPacket[], unknown];
  let i = 0;
  for (const r of rows as any[]) {
    const title = nonEmpty(r.client) ?? `Banner ${r.tribeversity_banner_id}`;
    await prisma.banner.upsert({
      where: { legacyId: r.tribeversity_banner_id },
      create: {
        legacyId: r.tribeversity_banner_id,
        title,
        imageUrl: nonEmpty(r.link_url) ?? '',
        linkUrl: nonEmpty(r.link_url),
        position: 0,
        isActive: bool(r.is_active),
      },
      update: { title, isActive: bool(r.is_active) },
    });
    i++;
  }
  log(`banners: ${i} done`);
}

async function migrateMembers(legacy: Connection) {
  log('members: streaming');
  // Distinct emails: keep lowest member_id per email
  const baseSql = `SELECT member_id, email, name, first_name, last_name, phone,
    password, image_url, biography, is_active, is_email_verified, date_register
    FROM member WHERE email <> '' AND email IS NOT NULL
      AND password IS NOT NULL AND password <> ''
      AND status=1`;

  const seenEmail = new Set<string>();
  const seenPhone = new Set<string>();
  let scanned = 0,
    inserted = 0,
    skipped = 0,
    page = 0;

  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'member_id', 5000)) {
    page++;
    const data: any[] = [];
    for (const r of rows as any[]) {
      scanned++;
      const email = nonEmpty(r.email)?.toLowerCase();
      if (!email) {
        skipped++;
        continue;
      }
      if (seenEmail.has(email)) {
        skipped++;
        continue;
      }
      const phone = nonEmpty(r.phone);
      const phoneKey = phone ?? '';
      if (phone && seenPhone.has(phoneKey)) {
        // dup phone — drop phone but still insert member
      }
      seenEmail.add(email);
      if (phone) seenPhone.add(phoneKey);

      const fullName =
        nonEmpty(r.name) ??
        ([nonEmpty(r.first_name), nonEmpty(r.last_name)].filter(Boolean).join(' ') || null);

      data.push({
        legacyId: r.member_id as number,
        email,
        phone: seenPhone.size === 0 || !phone ? phone : phone, // simplified
        fullName,
        passwordHash: String(r.password),
        passwordAlgo: 'legacy',
        avatarUrl: nonEmpty(r.image_url),
        bio: nonEmpty(r.biography),
        isActive: bool(r.is_active),
        isVerified: bool(r.is_email_verified),
        createdAt: date(r.date_register) ?? new Date(),
      });
    }
    if (data.length) {
      try {
        const res = await prisma.member.createMany({ data, skipDuplicates: true });
        inserted += res.count;
      } catch (err) {
        // Fall back to per-row on conflict (e.g. duplicate phone unique)
        for (const row of data) {
          try {
            await prisma.member.upsert({
              where: { legacyId: row.legacyId },
              create: row,
              update: {},
            });
            inserted++;
          } catch (e) {
            // duplicate phone -> retry without phone
            try {
              await prisma.member.upsert({
                where: { legacyId: row.legacyId },
                create: { ...row, phone: null },
                update: {},
              });
              inserted++;
            } catch {
              skipped++;
            }
          }
        }
      }
    }
    if (page % PROGRESS_EVERY === 0) {
      log(`members: page ${page} scanned=${scanned} inserted=${inserted} skipped=${skipped}`);
    }
  }
  log(`members: DONE scanned=${scanned} inserted=${inserted} skipped=${skipped}`);
}

async function migrateNetworks(legacy: Connection) {
  log('networks: streaming');
  const baseSql = `SELECT network_id, name, biography, logo_image_url, status
    FROM network WHERE status=1 AND (is_deleted IS NULL OR is_deleted=0)`;
  let inserted = 0;
  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'network_id', 5000)) {
    const data = (rows as any[])
      .map((r) => {
        const name = nonEmpty(r.name);
        if (!name) return null;
        return {
          legacyId: r.network_id as number,
          name,
          description: nonEmpty(r.biography),
          iconUrl: nonEmpty(r.logo_image_url),
          createdAt: new Date(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (data.length) {
      const res = await prisma.network.createMany({ data, skipDuplicates: true });
      inserted += res.count;
    }
  }
  log(`networks: ${inserted} inserted`);
}

async function migrateTopics(legacy: Connection) {
  log('topics: building network map');
  const networkMap = await buildMap(prisma.network);
  log(`networks mapped: ${networkMap.size}`);

  const baseSql = `SELECT topic_id, network_id, name, description, image_url, status
    FROM topic WHERE status=1`;
  let inserted = 0,
    skipped = 0;
  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'topic_id', 5000)) {
    const data = (rows as any[])
      .map((r) => {
        const name = nonEmpty(r.name);
        if (!name) {
          skipped++;
          return null;
        }
        const networkId = r.network_id ? networkMap.get(r.network_id) ?? null : null;
        return {
          legacyId: r.topic_id as number,
          networkId,
          name,
          description: nonEmpty(r.description),
          iconUrl: nonEmpty(r.image_url),
          isActive: true,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (data.length) {
      const res = await prisma.topic.createMany({ data, skipDuplicates: true });
      inserted += res.count;
    }
  }
  log(`topics: ${inserted} inserted, ${skipped} skipped`);
}

async function migrateNetworkMembers(legacy: Connection) {
  log('network-members: building maps');
  const memberMap = await buildMap(prisma.member);
  log(`members mapped: ${memberMap.size}`);
  const networkMap = await buildMap(prisma.network);
  log(`networks mapped: ${networkMap.size}`);

  const baseSql = `SELECT network_member_id, network_id, member_id, join_date
    FROM network_member WHERE status=1`;
  let inserted = 0,
    skipped = 0,
    page = 0;
  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'network_member_id', 5000)) {
    page++;
    const data = (rows as any[])
      .map((r) => {
        const networkId = r.network_id ? networkMap.get(r.network_id) : null;
        const memberId = r.member_id ? memberMap.get(r.member_id) : null;
        if (!networkId || !memberId) {
          skipped++;
          return null;
        }
        return {
          legacyId: r.network_member_id as number,
          networkId,
          memberId,
          joinedAt: date(r.join_date) ?? new Date(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (data.length) {
      const res = await prisma.networkMember.createMany({ data, skipDuplicates: true });
      inserted += res.count;
    }
    if (page % PROGRESS_EVERY === 0) log(`network-members: page ${page} inserted=${inserted}`);
  }
  log(`network-members: DONE inserted=${inserted} skipped=${skipped}`);
}

async function migratePosts(legacy: Connection) {
  log('posts: building maps');
  const memberMap = await buildMap(prisma.member);
  const topicMap = await buildMap(prisma.topic);
  log(`members=${memberMap.size} topics=${topicMap.size}`);

  const baseSql = `SELECT post_id, member_id, topic_id, content, image_url, created
    FROM post WHERE status=1 AND is_active=1 AND member_id IS NOT NULL`;
  let inserted = 0,
    skipped = 0,
    page = 0;
  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'post_id', 2000)) {
    page++;
    const data = (rows as any[])
      .map((r) => {
        const authorId = memberMap.get(r.member_id);
        if (!authorId) {
          skipped++;
          return null;
        }
        const topicId = r.topic_id ? topicMap.get(r.topic_id) ?? null : null;
        const imgRaw = nonEmpty(r.image_url);
        const imageUrls = imgRaw
          ? imgRaw
              .split(/[,;\n]/)
              .map((u) => u.trim())
              .filter((u) => u.length > 0)
          : [];
        const content = nonEmpty(r.content) ?? '';
        return {
          legacyId: r.post_id as number,
          authorId,
          topicId,
          content,
          imageUrls,
          isDeleted: false,
          createdAt: date(r.created) ?? new Date(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (data.length) {
      const res = await prisma.post.createMany({ data, skipDuplicates: true });
      inserted += res.count;
    }
    if (page % PROGRESS_EVERY === 0) log(`posts: page ${page} inserted=${inserted}`);
  }
  log(`posts: DONE inserted=${inserted} skipped=${skipped}`);
}

async function migrateComments(legacy: Connection) {
  log('comments: building maps');
  const memberMap = await buildMap(prisma.member);
  const postMap = await buildMap(prisma.post);
  log(`members=${memberMap.size} posts=${postMap.size}`);

  const baseSql = `SELECT comment_id, post_id, member_id, reply_id, content, created
    FROM comment WHERE status=1 AND is_active=1 AND post_id IS NOT NULL AND member_id IS NOT NULL`;

  // Two-pass: first inserting top-level (reply_id IS NULL), then replies (parent legacyId resolved)
  log('comments: pass 1 — top-level');
  let pass1 = 0;
  for await (const rows of paginate<RowDataPacket>(
    legacy,
    `${baseSql} AND (reply_id IS NULL OR reply_id=0)`,
    'comment_id',
    5000,
  )) {
    const data = (rows as any[])
      .map((r) => {
        const postId = postMap.get(r.post_id);
        const authorId = memberMap.get(r.member_id);
        if (!postId || !authorId) return null;
        return {
          legacyId: r.comment_id as number,
          postId,
          authorId,
          parentId: null as string | null,
          content: nonEmpty(r.content) ?? '',
          isDeleted: false,
          createdAt: date(r.created) ?? new Date(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (data.length) {
      const res = await prisma.comment.createMany({ data, skipDuplicates: true });
      pass1 += res.count;
    }
  }
  log(`comments pass 1: ${pass1} inserted`);

  log('comments: pass 2 — replies');
  const commentMap = await buildMap(prisma.comment);
  let pass2 = 0;
  for await (const rows of paginate<RowDataPacket>(
    legacy,
    `${baseSql} AND reply_id IS NOT NULL AND reply_id<>0`,
    'comment_id',
    5000,
  )) {
    const data = (rows as any[])
      .map((r) => {
        const postId = postMap.get(r.post_id);
        const authorId = memberMap.get(r.member_id);
        const parentId = commentMap.get(r.reply_id);
        if (!postId || !authorId || !parentId) return null;
        return {
          legacyId: r.comment_id as number,
          postId,
          authorId,
          parentId,
          content: nonEmpty(r.content) ?? '',
          isDeleted: false,
          createdAt: date(r.created) ?? new Date(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (data.length) {
      const res = await prisma.comment.createMany({ data, skipDuplicates: true });
      pass2 += res.count;
    }
  }
  log(`comments pass 2: ${pass2} inserted`);
}

async function migratePostLikes(legacy: Connection) {
  log('post-likes: building maps');
  const memberMap = await buildMap(prisma.member);
  const postMap = await buildMap(prisma.post);

  const baseSql = `SELECT like_id, post_id, member_id, created FROM \`like\`
    WHERE status=1 AND post_id IS NOT NULL AND (comment_id IS NULL OR comment_id=0)
      AND member_id IS NOT NULL`;
  let inserted = 0,
    skipped = 0,
    page = 0;
  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'like_id', 5000)) {
    page++;
    const data = (rows as any[])
      .map((r) => {
        const postId = postMap.get(r.post_id);
        const memberId = memberMap.get(r.member_id);
        if (!postId || !memberId) {
          skipped++;
          return null;
        }
        return {
          postId,
          memberId,
          createdAt: date(r.created) ?? new Date(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (data.length) {
      const res = await prisma.postLike.createMany({ data, skipDuplicates: true });
      inserted += res.count;
    }
    if (page % PROGRESS_EVERY === 0) log(`post-likes: page ${page} inserted=${inserted}`);
  }
  log(`post-likes: DONE inserted=${inserted} skipped=${skipped}`);
}

async function migrateCommentLikes(legacy: Connection) {
  log('comment-likes: building maps');
  const memberMap = await buildMap(prisma.member);
  const commentMap = await buildMap(prisma.comment);

  const baseSql = `SELECT like_id, comment_id, member_id, created FROM \`like\`
    WHERE status=1 AND comment_id IS NOT NULL AND comment_id<>0 AND member_id IS NOT NULL`;
  let inserted = 0,
    skipped = 0,
    page = 0;
  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'like_id', 5000)) {
    page++;
    const data = (rows as any[])
      .map((r) => {
        const commentId = commentMap.get(r.comment_id);
        const memberId = memberMap.get(r.member_id);
        if (!commentId || !memberId) {
          skipped++;
          return null;
        }
        return {
          commentId,
          memberId,
          createdAt: date(r.created) ?? new Date(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (data.length) {
      const res = await prisma.commentLike.createMany({ data, skipDuplicates: true });
      inserted += res.count;
    }
    if (page % PROGRESS_EVERY === 0) log(`comment-likes: page ${page} inserted=${inserted}`);
  }
  log(`comment-likes: DONE inserted=${inserted} skipped=${skipped}`);
}

async function migrateProducts(legacy: Connection) {
  log('products: fetching');
  const [rows] = (await legacy.query(
    `SELECT product_id, name, description, image_url_cover, price, status FROM product WHERE status=1`,
  )) as [RowDataPacket[], unknown];
  let inserted = 0;
  for (const r of rows as any[]) {
    const title = nonEmpty(r.name);
    if (!title) continue;
    await prisma.product.upsert({
      where: { legacyId: r.product_id },
      create: {
        legacyId: r.product_id,
        type: 'legacy',
        title,
        description: nonEmpty(r.description),
        thumbnail: nonEmpty(r.image_url_cover),
        price: Math.round(Number(r.price ?? 0)),
        isActive: bool(r.status),
      },
      update: {
        title,
        description: nonEmpty(r.description),
        price: Math.round(Number(r.price ?? 0)),
      },
    });
    inserted++;
  }
  log(`products: ${inserted} done`);
}

async function migrateAffiliatePrograms(legacy: Connection) {
  log('affiliate-programs: building maps');
  const productMap = await buildMap(prisma.product);

  // AffiliateProgram schema: legacyId, code (required+unique), name (required), productId?, isActive.
  const baseSql = `SELECT napa.network_account_product_affiliator_id,
    napa.productable, napa.productable_id, napa.name, napa.is_active, napa.created
    FROM network_account_product_affiliator napa
    WHERE napa.status=1 AND napa.deleted IS NULL`;
  let inserted = 0,
    page = 0;
  for await (const rows of paginate<RowDataPacket>(
    legacy,
    baseSql,
    'network_account_product_affiliator_id',
    2000,
  )) {
    page++;
    const data = (rows as any[]).map((r) => {
      // legacy uses Laravel polymorphic — link only if productable=Product
      const isProduct =
        typeof r.productable === 'string' && r.productable.toLowerCase().includes('product');
      const productId =
        isProduct && r.productable_id ? productMap.get(r.productable_id) ?? null : null;
      const legacyId = r.network_account_product_affiliator_id as number;
      return {
        legacyId,
        productId,
        code: `PROG-${legacyId}`, // deterministic, satisfies required+unique code
        name: nonEmpty(r.name) ?? `Program ${legacyId}`,
        isActive: bool(r.is_active),
        createdAt: date(r.created) ?? new Date(),
      };
    });
    if (data.length) {
      const res = await prisma.affiliateProgram.createMany({ data, skipDuplicates: true });
      inserted += res.count;
    }
    if (page % PROGRESS_EVERY === 0) log(`affiliate-programs: page ${page} inserted=${inserted}`);
  }
  log(`affiliate-programs: DONE inserted=${inserted}`);
}

async function migrateMemberAffiliators(legacy: Connection) {
  log('member-affiliators: building maps');
  const memberMap = await buildMap(prisma.member);
  const programMap = await buildMap(prisma.affiliateProgram);
  log(`members=${memberMap.size} programs=${programMap.size}`);

  const baseSql = `SELECT mpa.member_product_affiliator_id,
    mpa.network_account_product_affiliator_id AS program_id,
    mpa.affiliate_request_id, mpa.exit_state, mpa.exit_date,
    mpa.fb_pixel_id, mpa.tiktok_pixel_id, mpa.created, mpa.status,
    ar.member_id
    FROM member_product_affiliator mpa
    INNER JOIN affiliate_request ar ON ar.affiliate_request_id = mpa.affiliate_request_id
    WHERE mpa.status=1 AND ar.member_id IS NOT NULL`;
  let inserted = 0,
    skipped = 0,
    page = 0;
  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'member_product_affiliator_id', 2000)) {
    page++;
    const seenPair = new Set<string>();
    const data = (rows as any[])
      .map((r) => {
        const memberId = r.member_id ? memberMap.get(r.member_id) : null;
        const programId = r.program_id ? programMap.get(r.program_id) : null;
        if (!memberId || !programId) {
          skipped++;
          return null;
        }
        const key = `${memberId}|${programId}`;
        if (seenPair.has(key)) {
          skipped++;
          return null;
        }
        seenPair.add(key);
        return {
          legacyId: r.member_product_affiliator_id as number,
          memberId,
          programId,
          exitState: nonEmpty(r.exit_state),
          exitAt: date(r.exit_date),
          isActive: bool(r.status),
          createdAt: date(r.created) ?? new Date(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (data.length) {
      const res = await prisma.memberAffiliator.createMany({ data, skipDuplicates: true });
      inserted += res.count;
    }
    if (page % PROGRESS_EVERY === 0)
      log(`member-affiliators: page ${page} inserted=${inserted}`);
  }
  log(`member-affiliators: DONE inserted=${inserted} skipped=${skipped}`);
}

async function migrateAffiliateCommissions(legacy: Connection) {
  log('affiliate-commissions: building maps');
  const memberMap = await buildMap(prisma.member);
  const programMap = await buildMap(prisma.affiliateProgram);
  const affMap = await buildMap(prisma.memberAffiliator);
  const productMap = await buildMap(prisma.product);

  const baseSql = `SELECT affiliator_commision_id, network_account_product_affiliator_id AS program_id,
    member_recipient_id, member_product_affiliator_id, product_id, product_model,
    level, commision_type, commision_amount, price_recipient, product_price,
    fee_service_percent, fee_service_price, payment_id, payment_model,
    is_pending, is_super_commision, is_expired, affiliate_based, created, status
    FROM affiliator_commision WHERE status=1`;
  let inserted = 0,
    skipped = 0,
    page = 0;
  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'affiliator_commision_id', 2000)) {
    page++;
    const data = (rows as any[])
      .map((r) => {
        const recipientId = r.member_recipient_id ? memberMap.get(r.member_recipient_id) : null;
        if (!recipientId) {
          skipped++;
          return null;
        }
        const programId = r.program_id ? programMap.get(r.program_id) ?? null : null;
        const affiliatorId = r.member_product_affiliator_id
          ? affMap.get(r.member_product_affiliator_id) ?? null
          : null;
        const productId =
          r.product_model === 'Product' && r.product_id ? productMap.get(r.product_id) ?? null : null;
        // Map legacy status flags onto the new ledger status.
        const status = bool(r.is_pending) ? 'PENDING' : bool(r.is_expired) ? 'VOIDED' : 'BALANCE';
        return {
          legacyId: r.affiliator_commision_id as number,
          recipientId,
          affiliatorId,
          programId,
          productId,
          level: Number(r.level ?? 1),
          affiliateBased: nonEmpty(r.affiliate_based) ?? 'PERFORMANCE',
          productPrice: Math.round(Number(r.product_price ?? 0)),
          voucherAmount: 0,
          commissionRate: Number(r.commision_amount ?? 0),
          amount: Math.round(Number(r.price_recipient ?? 0)),
          status,
          paymentLegacyId: r.payment_id ? Number(r.payment_id) : null,
          createdAt: date(r.created) ?? new Date(),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (data.length) {
      const res = await prisma.affiliateCommission.createMany({ data, skipDuplicates: true });
      inserted += res.count;
    }
    if (page % PROGRESS_EVERY === 0)
      log(`affiliate-commissions: page ${page} inserted=${inserted}`);
  }
  log(`affiliate-commissions: DONE inserted=${inserted} skipped=${skipped}`);
}

async function migrateMemberReports(legacy: Connection) {
  log('member-reports: fetching');
  const memberMap = await buildMap(prisma.member);
  const catMap = await buildMap(prisma.reportCategory);
  const [rows] = (await legacy.query(
    `SELECT member_report_member_id AS id, member_id AS reporter_id,
            member_to_id AS target_id, member_report_member_category_id AS category_id,
            remark AS reason, created FROM member_report_member`,
  )) as [RowDataPacket[], unknown];
  let inserted = 0,
    skipped = 0;
  for (const r of rows as any[]) {
    const reporterId = memberMap.get(r.reporter_id);
    const targetId = memberMap.get(r.target_id);
    const categoryId = catMap.get(r.category_id);
    if (!reporterId || !targetId || !categoryId) {
      skipped++;
      continue;
    }
    await prisma.memberReport.create({
      data: {
        reporterId,
        targetId,
        categoryId,
        reason: nonEmpty(r.reason),
        createdAt: date(r.created) ?? new Date(),
      },
    });
    inserted++;
  }
  log(`member-reports: ${inserted} inserted, ${skipped} skipped`);
}

// ---------------------------------------------------------------------------
// Backfill — fills denorm/extra columns from legacy via UPDATE FROM (VALUES ...)
// ---------------------------------------------------------------------------

async function backfillBatch(
  table: string,
  columns: string[],
  rows: any[][],
): Promise<number> {
  if (rows.length === 0) return 0;
  // Postgres caps prepared-statement parameters at 32767. Chunk by columns.
  const maxRows = Math.max(1, Math.floor(30000 / columns.length));
  let total = 0;
  for (const sub of chunk(rows, maxRows)) {
    const placeholders = sub
      .map((_, i) => `(${columns.map((_, j) => `$${i * columns.length + j + 1}`).join(',')})`)
      .join(',');
    const colList = columns.join(',');
    const setList = columns
      .filter((c) => c !== 'legacy_id')
      .map((c) => `"${c}" = COALESCE(v.${c}, "${table}"."${c}")`)
      .join(', ');
    const sql = `UPDATE "${table}" SET ${setList} FROM (VALUES ${placeholders}) AS v(${colList}) WHERE "${table}".legacy_id = v.legacy_id`;
    const flat = sub.flat();
    total += await prisma.$executeRawUnsafe(sql, ...flat);
  }
  return total;
}

async function backfillMembers(legacy: Connection) {
  log('backfill members: start');
  const baseSql = `SELECT member_id, first_name, last_name, phone_code, code,
    image_url, cover_image_url, is_phone_verified, biography
    FROM member WHERE email <> '' AND email IS NOT NULL
      AND password IS NOT NULL AND password <> '' AND status=1`;
  let updated = 0,
    page = 0;
  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'member_id', 5000)) {
    page++;
    const data = (rows as any[]).map((r) => [
      r.member_id,
      nonEmpty(r.first_name),
      nonEmpty(r.last_name),
      nonEmpty(r.phone_code),
      nonEmpty(r.code),
      nonEmpty(r.image_url),
      nonEmpty(r.cover_image_url),
      bool(r.is_phone_verified),
      nonEmpty(r.biography),
    ]);
    updated += await backfillBatch(
      'members',
      ['legacy_id', 'first_name', 'last_name', 'phone_code', 'code', 'avatar_url', 'cover_url', 'is_phone_verified', 'bio'],
      data,
    );
    if (page % PROGRESS_EVERY === 0) log(`backfill members: page ${page} updated=${updated}`);
  }
  log(`backfill members: DONE updated=${updated}`);
}

async function backfillPosts(legacy: Connection) {
  log('backfill posts: start');
  const networkMap = await buildMap(prisma.network);
  log(`networks mapped: ${networkMap.size}`);

  const baseSql = `SELECT post_id, network_id, title, post_type, excerpt,
    image_url, video_url, embed_url,
    count_like, count_comment, count_replies, view_count
    FROM post WHERE status=1 AND is_active=1 AND member_id IS NOT NULL`;
  let updated = 0,
    page = 0;
  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'post_id', 2000)) {
    page++;
    const data = (rows as any[]).map((r) => {
      const networkId = r.network_id ? networkMap.get(r.network_id) ?? null : null;
      return [
        r.post_id,
        networkId,
        nonEmpty(r.title),
        nonEmpty(r.post_type),
        nonEmpty(r.excerpt),
        nonEmpty(r.video_url),
        nonEmpty(r.embed_url),
        Number(r.count_like ?? 0),
        Number(r.count_comment ?? 0),
        Number(r.count_replies ?? 0),
        Number(r.view_count ?? 0),
      ];
    });
    updated += await backfillBatch(
      'posts',
      ['legacy_id', 'network_id', 'title', 'post_type', 'excerpt', 'video_url', 'embed_url',
       'count_like', 'count_comment', 'count_replies', 'view_count'],
      data,
    );
    if (page % PROGRESS_EVERY === 0) log(`backfill posts: page ${page} updated=${updated}`);
  }
  log(`backfill posts: DONE updated=${updated}`);
}

async function backfillComments(legacy: Connection) {
  log('backfill comments: start');
  const baseSql = `SELECT comment_id, count_like, count_replies, image_url
    FROM comment WHERE status=1 AND is_active=1 AND post_id IS NOT NULL AND member_id IS NOT NULL`;
  let updated = 0,
    page = 0;
  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'comment_id', 5000)) {
    page++;
    const data = (rows as any[]).map((r) => [
      r.comment_id,
      Number(r.count_like ?? 0),
      Number(r.count_replies ?? 0),
    ]);
    updated += await backfillBatch(
      'comments',
      ['legacy_id', 'count_like', 'count_replies'],
      data,
    );
    if (page % PROGRESS_EVERY === 0) log(`backfill comments: page ${page} updated=${updated}`);
  }
  log(`backfill comments: DONE updated=${updated}`);
}

async function backfillNetworks(legacy: Connection) {
  log('backfill networks: start');
  const baseSql = `SELECT network_id, logo_image_url, banner_image_url, count_member, is_paid
    FROM network WHERE status=1`;
  let updated = 0,
    page = 0;
  for await (const rows of paginate<RowDataPacket>(legacy, baseSql, 'network_id', 5000)) {
    page++;
    const data = (rows as any[]).map((r) => [
      r.network_id,
      nonEmpty(r.logo_image_url),
      nonEmpty(r.banner_image_url),
      Number(r.count_member ?? 0),
      bool(r.is_paid),
    ]);
    updated += await backfillBatch(
      'networks',
      ['legacy_id', 'icon_url', 'banner_url', 'count_member', 'is_paid'],
      data,
    );
    if (page % PROGRESS_EVERY === 0) log(`backfill networks: page ${page} updated=${updated}`);
  }
  log(`backfill networks: DONE updated=${updated}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const PHASES: Record<string, (legacy: Connection) => Promise<void>> = {
  master: async (legacy) => {
    await migrateCountries(legacy);
    await migrateProvinces(legacy);
    await migrateCities(legacy);
    await migrateDistricts(legacy);
    await migrateReportCategories(legacy);
    await migrateBanners(legacy);
  },
  members: migrateMembers,
  networks: migrateNetworks,
  topics: migrateTopics,
  'network-members': migrateNetworkMembers,
  posts: migratePosts,
  comments: migrateComments,
  'post-likes': migratePostLikes,
  'comment-likes': migrateCommentLikes,
  products: migrateProducts,
  reports: migrateMemberReports,
  'affiliate-programs': migrateAffiliatePrograms,
  'member-affiliators': migrateMemberAffiliators,
  'affiliate-commissions': migrateAffiliateCommissions,
  affiliate: async (legacy) => {
    await migrateAffiliatePrograms(legacy);
    await migrateMemberAffiliators(legacy);
    await migrateAffiliateCommissions(legacy);
  },
  'backfill-members': backfillMembers,
  'backfill-posts': backfillPosts,
  'backfill-comments': backfillComments,
  'backfill-networks': backfillNetworks,
  backfill: async (legacy) => {
    await backfillMembers(legacy);
    await backfillNetworks(legacy);
    await backfillPosts(legacy);
    await backfillComments(legacy);
  },
};

const DEFAULT_ORDER = [
  'master',
  'members',
  'networks',
  'topics',
  'network-members',
  'posts',
  'comments',
  'post-likes',
  'comment-likes',
  'products',
  'reports',
  'affiliate',
  'backfill',
];

async function main() {
  const argv = process.argv.slice(2);
  const requested = argv.length > 0 ? argv.join(',').split(',').map((s) => s.trim()) : DEFAULT_ORDER;
  log(`phases: ${requested.join(', ')}`);

  const legacy = await connectLegacyDb({ dateStrings: false });
  log('connected to legacy mariadb');

  try {
    for (const name of requested) {
      const fn = PHASES[name];
      if (!fn) {
        log(`unknown phase: ${name} (skipped)`);
        continue;
      }
      const t0 = Date.now();
      log(`=== phase: ${name} ===`);
      await fn(legacy);
      log(`=== phase ${name} done in ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
    }
  } finally {
    await legacy.end();
    await prisma.$disconnect();
  }
  log('migration complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
