import type { Product } from '@prisma/client';

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
  opts: { ratingAvg?: number; isPurchased?: boolean } = {},
): Record<string, unknown> {
  const productId = p.legacyId ?? p.id;
  const label = productTypeLabel(p.type);
  const slug = p.slug ?? deriveSlug(p.title);
  const code = p.code ?? String(productId);
  const baseUrl = process.env.PUBLIC_WEB_URL ?? 'https://brainboost.com';
  const productUrl = p.marketingLink ?? `${baseUrl}/p/${slug}`;
  // FE ProductModel reads leftmost-of-fallback. Backend emits only the
  // canonical (leftmost) name per audit §3.1 — aliases dropped.
  return {
    id: p.id,
    networkAccountProductAffiliatorId: productId,
    productType: p.type,
    productTypeLabel: label,
    productCode: code,
    productSlug: slug,
    productName: p.title,
    productCategory: p.tags
      ? p.tags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    productPrice: p.price,
    productImageUrl: p.thumbnail,
    lastUpdated: p.updatedAt.toISOString(),
    productPaymentUrl: `${baseUrl}/checkout/${code}`,
    productShareDetailUrl: productUrl,
    commisionFixAmount: null,
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
    audio?: Record<string, unknown>;
    video?: Record<string, unknown>;
  };
}

// Flatten `lessonsData[].courseLessonData[].slidesData[]` into a flat list of
// `{id, type, title, description, audio?, video?}` items (FE ProductDataContent).
// Mirrors legacy mobile transform — only AudioTemplate / VideoTemplate slides emitted.
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
        };
        if (type === 'AudioTemplate' && d.audio) {
          const a = d.audio;
          item.audio = {
            id: a.id ?? null,
            title: a.title ?? null,
            description: a.description ?? null,
            duration: a.duration ?? slide.duration ?? 0,
            videoLibraryId: a.videoLibraryId ?? null,
            guid: a.guid ?? null,
            audioName: a.audioName ?? null,
            availableRes: a.availableRes ?? null,
          };
        }
        if (type === 'VideoTemplate' && d.video) {
          const v = d.video;
          item.video = {
            id: v.id ?? null,
            title: v.title ?? null,
            description: v.description ?? null,
            platform: v.platform ?? null,
            url: v.url ?? null,
            duration: v.duration ?? slide.duration ?? 0,
          };
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
          const slides = normalizeSlidesData(l.slidesData);
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
