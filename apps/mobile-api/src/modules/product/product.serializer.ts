import type { Product } from '@prisma/client';
import { signMediaToken } from '@/modules/media/media-token.util';
import { env } from '@bb/common/config/env';

/**
 * Map product `type` to a human label per legacy convention.
 * Fallback: capitalize the type itself.
 */
function productTypeLabel(type: string | null): string {
  if (!type) return '';
  const map: Record<string, string> = {
    course: 'Course',
    bundle: 'Bundle',
    book: 'Book',
    digital: 'Digital',
  };
  return map[type.toLowerCase()] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

function deriveSlug(title: string | null): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

export function serializeProduct(
  p: Product,
  opts: { ratingAvg?: number; isPurchased?: boolean; commissionRate?: number } = {},
): Record<string, unknown> {
  const productId = p.legacyId ?? p.id;
  const label = productTypeLabel(p.type);
  const slug = p.slug ?? deriveSlug(p.title);
  const code = p.code ?? String(productId);
  const baseUrl = process.env.PUBLIC_WEB_URL ?? 'https://brainboost.com';
  const productUrl = p.marketingLink ?? `${baseUrl}/p/${slug}`;
  // Clean field names aligned with product/course/detail convention (FE
  // backend-contract audit P2). Legacy `product*`-prefixed keys renamed:
  // productType→type, productTypeLabel→typeLabel, productCode→code,
  // productSlug→slug, productName→name, productPrice→price,
  // productImageUrl→imageUrl, productCategory→category,
  // productShareDetailUrl→shareUrl. `lastUpdated` kept (FE accepts).
  // `networkAccountProductAffiliatorId` retained pending P3 int-id removal.
  //
  // Affiliate commission RANGE: an iOS purchase pays the affiliator on the NET we
  // take home (gross iOS price minus Apple's ~30% store cut), so the same product
  // earns slightly less via iOS than via web. max = web-price basis, min = iOS-net
  // basis; min falls back to max when no iOS price is set.
  const rate = opts.commissionRate ?? 20;
  const IAP_STORE_CUT_PCT = 30;
  const commissionMax = p.price > 0 ? Math.trunc((p.price * rate) / 100) : 0;
  const iosNet =
    p.iosPrice && p.iosPrice > 0
      ? Math.trunc((p.iosPrice * (100 - IAP_STORE_CUT_PCT)) / 100)
      : null;
  const commissionMin = iosNet != null ? Math.trunc((iosNet * rate) / 100) : commissionMax;

  return {
    id: p.id,
    networkAccountProductAffiliatorId: productId,
    iosProductId: p.iosProductId,
    androidProductId: p.androidProductId,
    type: p.type,
    typeLabel: label,
    code,
    slug,
    name: p.title,
    category: p.tags
      ? p.tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    price: p.price,
    imageUrl: p.thumbnail,
    lastUpdated: p.updatedAt.toISOString(),
    productPaymentUrl: `${baseUrl}/checkout/${code}`,
    shareUrl: productUrl,
    // Affiliate-earning preview. Legacy mobile (TribeversityMobile/Product.php:208)
    // used a flat 20%; here it is the caller's PERFORMANCE-tier rate (20/30/40,
    // tier 1 = 20% default for anon/no-history members), applied globally — the new
    // backend has no per-product `pbs_aff_*` overrides (per-program rate config not
    // ported). `(int)` cast like legacy program/detail.blade.php:46 → Math.trunc.
    commisionFixAmount: commissionMax, // legacy single value = web-price basis (= range max)
    commissionMin,
    commissionMax,
    productUrl,
    isPurchased: opts.isPurchased ?? false,
    productRatingAvg: opts.ratingAvg ?? 0,
  };
}

interface LessonLite {
  name: string;
  description: string | null;
  order: number;
  slidesData: unknown;
  legacyLessonId: number;
  code: string | null;
  slug: string | null;
  lessonStatus: string;
  isPreview: boolean;
  duration: number;
}

interface SectionLite {
  name: string;
  order: number;
  lessons: LessonLite[];
  legacySectionId: number;
}

interface CourseLite {
  /** Course UUID — needed to mint media tokens. Prisma `include`s the full course at runtime. */
  id: string;
  legacyCourseId: number | null;
  sections: SectionLite[];
}

interface ProductWithCourseDetail extends Product {
  course: CourseLite | null;
}

function normalizeSellingPoints(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  return [];
}

function normalizeSlidesData(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

interface RawSlide {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  duration?: unknown;
  data?: {
    title?: unknown;
    description?: unknown;
    platform?: unknown;
    audio?: Record<string, unknown>;
    /** Structured-video shape — guid lives in `data.video.guid`, like `data.audio`. */
    video?: Record<string, unknown>;
    /** Iframe-HTML shape — VideoTemplate Bunny embed wrapped in `data.url`. */
    url?: unknown;
    /** Injected by `scrubSlide` for VideoTemplate — opaque media-proxy URL. */
    streamUrl?: unknown;
    /** Injected by `scrubSlide` for AudioTemplate / VideoTemplate — long-lived MP4 download URL. */
    downloadUrl?: unknown;
  };
}

/**
 * Pull the Bunny `libraryId` + `guid` out of a VideoTemplate `data.url` blob,
 * which wraps an `<iframe src="https://iframe.mediadelivery.net/embed/{lib}/{guid}?...">`.
 * Returns `null` for non-Bunny URLs (e.g. YouTube / external embeds) so they
 * pass through untouched.
 */
function parseBunnyEmbed(html: string): { libraryId: string; guid: string } | null {
  const m = /iframe\.mediadelivery\.net\/embed\/(\d+)\/([0-9a-fA-F-]{36})/.exec(html);
  if (!m) return null;
  return { libraryId: m[1], guid: m[2] };
}

/**
 * Build the opaque media-proxy URL that replaces the raw Bunny `guid` /
 * `videoLibraryId` in client-facing responses.
 */
function buildStreamUrl(guid: string, courseId: string, isPreview: boolean): string {
  const token = signMediaToken({ guid, courseId, isPreview });
  return `/api/member/media/stream?t=${token}`;
}

/**
 * Build a long-lived signed download URL for the same Bunny asset. The opaque
 * token carries the longer download TTL so it does not expire before a slow
 * offline download finishes; the proxy endpoint then 302-redirects to a signed
 * Bunny MP4 URL.
 */
function buildDownloadUrl(guid: string, courseId: string, isPreview: boolean): string {
  const token = signMediaToken({ guid, courseId, isPreview }, env.media.downloadTtlSeconds);
  return `/api/member/media/download?t=${token}`;
}

/**
 * Scrub a single raw slide so no Bunny identifiers leak to the client.
 *
 * - AudioTemplate: replaces the whole `data.audio` Bunny object with `{ streamUrl, duration }`.
 * - VideoTemplate: drops the `data.url` iframe HTML, adds `data.streamUrl`.
 * - Any other slide type passes through unchanged.
 *
 * `courseId` (Course UUID) + `isPreview` (parent lesson) are baked into the
 * media token. Returns a shallow-cloned slide; the original JSONB is untouched.
 */
function scrubSlide(slide: RawSlide, courseId: string, isPreview: boolean): RawSlide {
  const type = typeof slide.type === 'string' ? slide.type : '';
  const d = slide.data ?? {};

  if (type === 'AudioTemplate' && d.audio) {
    const a = d.audio;
    const guid = typeof a.guid === 'string' ? a.guid : null;
    const cleanAudio: Record<string, unknown> = {
      duration: a.duration ?? slide.duration ?? 0,
    };
    if (guid) {
      cleanAudio.streamUrl = buildStreamUrl(guid, courseId, isPreview);
      cleanAudio.downloadUrl = buildDownloadUrl(guid, courseId, isPreview);
    }
    return {
      ...slide,
      data: {
        title: d.title,
        description: d.description,
        platform: 'mp4',
        audio: cleanAudio,
      },
    };
  }

  if (type === 'VideoTemplate') {
    const embed = typeof d.url === 'string' ? parseBunnyEmbed(d.url) : null;
    const v = d.video;
    const videoGuid = v && typeof v.guid === 'string' ? v.guid : null;
    const newData: Record<string, unknown> = {
      title: d.title,
      description: d.description,
      platform: 'mp4',
    };
    if (embed) {
      // Iframe-HTML shape — guid parsed out of the `data.url` blob.
      newData.streamUrl = buildStreamUrl(embed.guid, courseId, isPreview);
      newData.downloadUrl = buildDownloadUrl(embed.guid, courseId, isPreview);
    } else if (videoGuid) {
      // Structured shape — guid is `data.video.guid` (like AudioTemplate).
      newData.streamUrl = buildStreamUrl(videoGuid, courseId, isPreview);
      newData.downloadUrl = buildDownloadUrl(videoGuid, courseId, isPreview);
    } else if (typeof d.url === 'string') {
      // Non-Bunny embed (YouTube/external) — preserve the original url verbatim.
      newData.url = d.url;
      newData.platform = d.platform ?? 'mp4';
    }
    return { ...slide, data: newData };
  }

  // TextTemplate / GreetingTemplate / ThankYouTemplate / DocumentTemplate / ...
  return slide;
}

// Flatten `lessonsData[].courseLessonData[].slidesData[]` into a flat list of
// `{id, type, title, description, duration, streamUrl?}` items (FE ProductDataContent).
// Mirrors legacy mobile transform — only AudioTemplate / VideoTemplate slides emitted.
// Consumes already-scrubbed slides, so it never sees a raw Bunny `guid`.
function buildDataContent(
  lessonsData: { courseLessonData: { slidesData: unknown[] }[] }[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const section of lessonsData) {
    for (const lesson of section.courseLessonData) {
      for (const slide of lesson.slidesData as RawSlide[]) {
        const type = typeof slide.type === 'string' ? slide.type : '';
        if (type !== 'AudioTemplate' && type !== 'VideoTemplate') continue;
        const d = slide.data ?? {};
        const item: Record<string, unknown> = {
          id: slide.id ?? null,
          type,
          title: (d.title ?? slide.name ?? null) as unknown,
          description: d.description ?? null,
          platform: 'mp4',
        };
        if (type === 'AudioTemplate' && d.audio) {
          const a = d.audio;
          item.duration = a.duration ?? slide.duration ?? 0;
          if (typeof a.streamUrl === 'string') item.streamUrl = a.streamUrl;
          if (typeof a.downloadUrl === 'string') item.downloadUrl = a.downloadUrl;
        }
        if (type === 'VideoTemplate') {
          item.duration = slide.duration ?? 0;
          if (typeof d.streamUrl === 'string') item.streamUrl = d.streamUrl;
          if (typeof d.downloadUrl === 'string') item.downloadUrl = d.downloadUrl;
        }
        out.push(item);
      }
    }
  }
  return out;
}

function legacyDescriptionExcerpt(html: string | null, plain: string | null): string {
  const raw = (plain ?? (html ?? '').replace(/<[^>]+>/g, '')).trim();
  return raw.slice(0, 50);
}

function stripBrainboostLabel(title: string): string {
  return title
    .replace(/\s*\bBrainboost\b\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function legacyStatus(s: string): string {
  const m: Record<string, string> = {
    active: 'PUBLISH',
    inactive: 'INACTIVE',
    draft: 'DRAFT',
    archived: 'ARCHIVED',
  };
  return m[s.toLowerCase()] ?? s.toUpperCase();
}

function roundOneDecimal(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface ReviewAggregateInput {
  avg: number;
  total: number;
  distribution: Record<string, number>;
}

function buildStarSummary(
  aggregate: ReviewAggregateInput,
): Record<string, { total: number; star: number; percentage: number }> {
  const out: Record<string, { total: number; star: number; percentage: number }> = {};
  for (let s = 1; s <= 5; s += 1) {
    const total = aggregate.distribution[String(s)] ?? 0;
    const percentage = aggregate.total > 0 ? roundOneDecimal((total / aggregate.total) * 100) : 0;
    out[String(s)] = { total, star: s, percentage };
  }
  return out;
}

/**
 * Legacy `/api/member/product/course/detail` shape — 1:1 with tribelio-platform.
 * `ratingSummary` is computed live from the `reviews` table; section/lesson
 * legacy int IDs come from `legacySectionId`/`legacyLessonId` autoincrement
 * sequences. Multi-tenant fields (`networkAccountId`, `memberId`) are hardcoded
 * to 0 because this backend is single-tenant.
 */
export function serializeCourseDetailLegacy(
  p: ProductWithCourseDetail,
  reviewAggregate: ReviewAggregateInput,
  opts: { isPurchase?: boolean; affiliateCode?: string | null } = {},
): Record<string, unknown> {
  const baseUrl = process.env.PUBLIC_WEB_URL ?? 'https://brainboost.com';
  const code = p.code ?? String(p.legacyId ?? p.id);
  const slug = p.slug ?? deriveSlug(p.title);
  const productUrl = p.marketingLink ?? `${baseUrl}/p/${slug}`;
  const shareUrl = opts.affiliateCode ? `${productUrl}?affCode=${opts.affiliateCode}` : productUrl;
  const courseLegacyId = p.course?.legacyCourseId ?? p.legacyId ?? 0;
  // Course UUID — required to mint media tokens. `p.course` is null only for
  // non-course products; in that case there are no slides to scrub anyway.
  const courseUuid = p.course?.id ?? '';

  const lessonsData = (p.course?.sections ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((sec) => ({
      courseSectionId: sec.legacySectionId,
      courseId: courseLegacyId,
      networkAccountId: 0,
      memberId: 0,
      name: sec.name,
      orderColumn: sec.order,
      courseLessonData: sec.lessons
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((l) => {
          // Scrub each slide while the parent lesson's `isPreview` is in scope,
          // so Bunny `guid`/`videoLibraryId`/iframe-HTML never reach the client.
          const slides = normalizeSlidesData(l.slidesData).map((s) =>
            scrubSlide(s as RawSlide, courseUuid, l.isPreview),
          );
          return {
            courseLessonId: l.legacyLessonId,
            courseId: courseLegacyId,
            lessonName: l.name,
            lessonDescription: l.description,
            joined: 0,
            slideCount: slides.length,
            duration: l.duration,
            code: l.code ?? '',
            orderColumn: l.order,
            title: l.name,
            lessonStatus: l.lessonStatus,
            slug: l.slug ?? '',
            courseSectionId: sec.legacySectionId,
            isPreview: l.isPreview ? 1 : 0,
            slidesData: slides,
          };
        }),
    }));

  return {
    id: p.id,
    courseId: courseLegacyId,
    iosProductId: p.iosProductId,
    androidProductId: p.androidProductId,
    code,
    name: stripBrainboostLabel(p.title),
    description: p.description,
    descriptionHtml: p.descriptionHtml,
    sellingPoint: normalizeSellingPoints(p.sellingPoints),
    imageUrl: p.thumbnail,
    isPurchase: opts.isPurchase ?? false,
    productShareDetailUrl: shareUrl,
    productPaymentUrl: `${baseUrl}/checkout/${code}`,
    price: p.price,
    status: legacyStatus(p.status),
    lessonsData,
    dataContent: buildDataContent(lessonsData),
    ratingSummary: {
      totalReview: reviewAggregate.total,
      avgReviewStart: roundOneDecimal(reviewAggregate.avg),
      star: buildStarSummary(reviewAggregate),
    },
  };
}
