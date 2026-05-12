/**
 * Wire-format serializers for API responses. Field names follow the legacy
 * Tribelio mobile API contract so the existing Flutter client stays compatible.
 */
import type {
  Member,
  Network,
  Topic,
  Post,
  Comment,
  Country,
  Province,
  City,
  District,
  Banner,
  Product,
  Notification,
} from '@prisma/client';

interface MemberLite {
  id: string;
  legacyId: number | null;
  email: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  code: string | null;
}

export function serializeMember(m: Member | MemberLite): Record<string, unknown> {
  return {
    memberId: m.legacyId ?? m.id,
    id: m.id,
    code: (m as Member).code ?? null,
    email: m.email,
    name: m.fullName,
    firstName: m.firstName ?? null,
    lastName: m.lastName ?? null,
    imageUrl: m.avatarUrl,
    avatarUrl: m.avatarUrl,
  };
}

/**
 * Full member shape — legacy NetworkMember/Member fields used by mobile.
 * Mobile `NetworkMemberModel` expects: memberId, name, provinceId/Name,
 * cityId/Name, email, phone, gender, isEmailVerified, isPhoneVerified,
 * postalCode, imageUrl, coverUrl, biography, birthdate, address, dateRegister.
 */
export function serializeMemberFull(m: Member): Record<string, unknown> {
  return {
    ...serializeMember(m),
    phone: m.phone,
    phoneCode: m.phoneCode,
    coverUrl: m.coverUrl,
    bio: m.bio,
    biography: m.bio, // legacy alias
    gender: m.gender,
    birthdate: m.birthdate,
    isActive: m.isActive,
    isVerified: m.isVerified,
    isEmailVerified: m.isVerified, // legacy alias
    isPhoneVerified: m.isPhoneVerified,
    dateRegister: m.createdAt, // legacy alias
    createdAt: m.createdAt,
  };
}

export function serializeNetwork(
  n: Network & { members?: { memberId: string }[] } & Record<string, unknown>,
): Record<string, unknown> {
  return {
    networkId: n.legacyId ?? n.id,
    id: n.id,
    name: n.name,
    description: n.description,
    logoImageUrl: n.iconUrl,
    bannerImageUrl: n.bannerUrl,
    countMember: n.countMember,
    isPaid: n.isPaid,
    createdAt: n.createdAt,
  };
}

export function serializeTopic(
  t: Topic & { isSubscribed?: boolean; countPost?: number; orderNumber?: number },
): Record<string, unknown> {
  return {
    // Legacy field names (mobile TopicModel)
    topicId: t.legacyId ?? t.id,
    name: t.name,
    icon: t.iconUrl,
    iconType: t.iconUrl ? 'image' : null,
    type: t.type,
    countPost: t.countPost ?? 0,
    orderNumber: t.orderNumber ?? 0,
    isSubscribeTopic: t.isSubscribed ?? false,
    // Backend-native (extras)
    id: t.id,
    networkId: t.networkId,
    description: t.description,
    iconUrl: t.iconUrl,
    isActive: t.isActive,
    createdAt: t.createdAt,
  };
}

interface PostWithRelations extends Post {
  author?: Member | null;
  topic?: Topic | null;
}

// Detect FE video platform from URL. Bunny stream URLs contain "vz-" /
// "iframe.mediadelivery"; YouTube URLs contain "youtube" or "youtu.be".
function detectVideoPlatform(url: string | null): 'youtube' | 'bunnycdn' | 'other' | null {
  if (!url) return null;
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/bunnycdn|mediadelivery|vz-/i.test(url)) return 'bunnycdn';
  return 'other';
}

function buildPostContentData(content: string, excerpt: string | null) {
  // Rich-content model is not yet captured in Post schema. Emit a minimal
  // shape FE PostContentDataModel can parse without throwing.
  return {
    plain: content,
    linkData: [] as unknown[],
    attributeData: [] as unknown[],
    excerptIndex: null,
    excerpt,
  };
}

function buildPostTopic(t: Topic | null | undefined) {
  if (!t) return null;
  // FE PostTopicModel shape: `{topicId, topicName, topicType, topicIcon}`.
  return {
    topicId: t.legacyId ?? t.id,
    topicName: t.name,
    topicType: t.type,
    topicIcon: t.iconUrl,
  };
}

function buildPostCreator(m: Member | null | undefined) {
  if (!m) return null;
  // FE PostCreatorModel: `{memberId, name, profileImage, profileCoverImage}`.
  return {
    memberId: m.legacyId ?? m.id,
    name: m.fullName,
    profileImage: m.avatarUrl,
    profileCoverImage: m.coverUrl,
  };
}

export function serializePost(
  p: PostWithRelations,
  statusLike: 'like' | 'dislike' = 'dislike',
  opts: { viewerId?: string; isJoined?: boolean | null } = {},
): Record<string, unknown> {
  const memberId = p.author?.legacyId ?? null;
  const isAuthor = opts.viewerId != null && p.authorId === opts.viewerId;
  const baseUrl = process.env.PUBLIC_WEB_URL ?? 'https://brainboost.com';
  const postSlug = p.legacyId ?? p.id;
  const postUrl = `${baseUrl}/post/${postSlug}`;

  return {
    // FE PostModel — primary fields
    postId: p.legacyId ?? p.id,
    postContentData: buildPostContentData(p.content, p.excerpt),
    postType: p.postType,
    title: p.title,
    contentTitle: p.title,
    content: p.content,
    embed: p.embedUrl,
    embedUrl: p.embedUrl,
    embedData: null,
    fullContent: p.content,
    excerpt: p.excerpt,
    images: p.imageUrls,
    attachments: [] as unknown[],
    audios: [] as unknown[],
    memberIdPost: memberId,
    video: p.videoUrl
      ? {
          url: p.videoUrl,
          platform: detectVideoPlatform(p.videoUrl),
        }
      : null,
    videoThumbnailUrl: null,
    statusLike,
    countLike: p.countLike,
    starred: null,
    countComment: p.countComment,
    timeAgo: timeAgoString(p.createdAt),
    dateAgo: dateAgoString(p.createdAt),
    topic: buildPostTopic(p.topic),
    canEdit: isAuthor,
    canDelete: isAuthor,
    pinned: p.isPinned ? 1 : 0,
    havePolling: 0,
    creator: buildPostCreator(p.author),
    isJoined: opts.isJoined ?? null,
    publishStatus: p.publishStatus,
    postUrl,
    postOriginalUrl: postUrl,
    // Backend-native extras (FE tolerates)
    id: p.id,
    memberId,
    networkId: p.networkId,
    topicId: p.topic?.legacyId ?? p.topicId,
    countReplies: p.countReplies,
    viewCount: p.viewCount,
    videoUrl: p.videoUrl,
    isDeleted: p.isDeleted,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    member: p.author ? serializeMember(p.author) : null,
  };
}

interface CommentWithAuthor extends Comment {
  author?: Member | null;
  parent?: { legacyId: number | null } | null;
  post?: { legacyId: number | null } | null;
}

// Tracks both `commentId` parent legacyId (FE replyId expects int) and the post
// legacyId without forcing the caller to query each lookup separately.
function parseMentions(content: string): string[] {
  const matches = content.match(/@[A-Za-z0-9_]+/g);
  return matches ? Array.from(new Set(matches.map((m) => m.slice(1)))) : [];
}

function timeAgoString(d: Date, now: Date = new Date()): string {
  const diffSec = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  const diffWeek = Math.floor(diffDay / 7);
  if (diffWeek < 4) return `${diffWeek}w`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo`;
  return `${Math.floor(diffDay / 365)}y`;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateAgoString(d: Date, now: Date = new Date()): string {
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const sameYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (sameYesterday) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getDate()} ${MONTH_ABBR[d.getMonth()]}`;
  }
  return `${d.getDate()} ${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
}

export function serializeComment(
  c: CommentWithAuthor,
  statusLike: 'like' | 'dislike' = 'dislike',
): Record<string, unknown> {
  const mentions = parseMentions(c.content);
  return {
    // FE CommentModel — primary fields
    commentId: c.legacyId ?? c.id,
    replyId: c.parent?.legacyId ?? c.parentId ?? null,
    postId: c.post?.legacyId ?? c.postId,
    memberId: c.author?.legacyId ?? null,
    memberName: c.author?.fullName ?? null,
    memberProfileImage: c.author?.avatarUrl ?? null,
    embed: null,
    embedUrl: null,
    embedData: null,
    content: c.content,
    fullContent: c.content,
    image: c.imageUrls.length > 0 ? c.imageUrls[0] : null,
    audio: null,
    statusLike,
    timeAgo: timeAgoString(c.createdAt),
    dateAgo: dateAgoString(c.createdAt),
    countLike: c.countLike,
    countLikeInKilo: Math.round(c.countLike / 1000),
    replyCount: c.countReplies,
    mentions,
    // Backend-native extras (FE tolerates)
    id: c.id,
    parentId: c.parentId,
    images: c.imageUrls,
    isDeleted: c.isDeleted,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    member: c.author ? serializeMember(c.author) : null,
  };
}

// FE legacy http layer expects `{id: int, parent legacyIds, name}` per audit
// §49-52. `id` = legacyId, parent ids = parent's legacyId. Falls back to UUID
// string when legacyId is null (shouldn't happen in production data).

export function serializeCountry(c: Country): Record<string, unknown> {
  return {
    id: c.legacyId ?? c.id,
    name: c.name,
    code: c.code,
  };
}

interface ProvinceWithCountry extends Province {
  country?: { legacyId: number | null } | null;
}

export function serializeProvince(p: ProvinceWithCountry): Record<string, unknown> {
  return {
    id: p.legacyId ?? p.id,
    countryId: p.country?.legacyId ?? null,
    name: p.name,
  };
}

interface CityWithParents extends City {
  province?: ({ legacyId: number | null; country?: { legacyId: number | null } | null }) | null;
}

export function serializeCity(c: CityWithParents): Record<string, unknown> {
  return {
    id: c.legacyId ?? c.id,
    countryId: c.province?.country?.legacyId ?? null,
    provinceId: c.province?.legacyId ?? null,
    name: c.name,
  };
}

interface DistrictWithParents extends District {
  city?:
    | ({
        legacyId: number | null;
        province?:
          | ({ legacyId: number | null; country?: { legacyId: number | null } | null })
          | null;
      })
    | null;
}

export function serializeDistrict(d: DistrictWithParents): Record<string, unknown> {
  return {
    id: d.legacyId ?? d.id,
    countryId: d.city?.province?.country?.legacyId ?? null,
    provinceId: d.city?.province?.legacyId ?? null,
    cityId: d.city?.legacyId ?? null,
    name: d.name,
  };
}

export function serializeBanner(b: Banner): Record<string, unknown> {
  // FE BannerModel: `{id:int, client, link, image:List<String>}`. Aliased from
  // `legacyId` (= tribeversityBannerId), `title`, `linkUrl`, `[imageUrl]`.
  return {
    id: b.legacyId ?? b.id,
    client: b.title,
    link: b.linkUrl ?? '',
    image: [b.imageUrl],
  };
}

// FE NetworkMemberModel is flat — mix Member + Member.profile + joinedAt.
interface NetworkMemberRow {
  id: string;
  legacyId: number | null;
  email: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  bio: string | null;
  phone: string | null;
  gender: string | null;
  birthdate: Date | null;
  isVerified: boolean;
  isPhoneVerified: boolean;
  createdAt: Date;
  profile?: {
    address: string | null;
    postalCode: string | null;
    province?: { legacyId: number | null; name: string } | null;
    city?: { legacyId: number | null; name: string } | null;
  } | null;
}

export function serializeNetworkMemberLegacy(
  m: NetworkMemberRow,
  joinedAt: Date,
): Record<string, unknown> {
  const p = m.profile;
  return {
    memberId: m.legacyId ?? m.id,
    name: m.fullName ?? (`${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || null),
    provinceId: p?.province?.legacyId ?? null,
    provinceName: p?.province?.name ?? null,
    cityId: p?.city?.legacyId ?? null,
    cityName: p?.city?.name ?? null,
    email: m.email,
    phone: m.phone,
    gender: m.gender,
    isEmailVerified: m.isVerified ? 1 : 0,
    isPhoneVerified: m.isPhoneVerified ? 1 : 0,
    postalCode: p?.postalCode ?? null,
    imageUrl: m.avatarUrl,
    coverUrl: m.coverUrl,
    biography: m.bio,
    birthdate: m.birthdate ? m.birthdate.toISOString().slice(0, 10) : null,
    address: p?.address ?? null,
    dateRegister: joinedAt.toISOString(),
  };
}

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
  return {
    // Primary legacy keys (mobile ProductModel.fromAPIJson reads these first)
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
    lastUpdated: p.updatedAt,
    productPaymentUrl: `${baseUrl}/checkout/${code}`,
    productShareDetailUrl: productUrl,
    commisionFixAmount: null,
    productUrl,
    isPurchased: opts.isPurchased ?? false,
    productRatingAvg: opts.ratingAvg ?? 0,
    // Fallback aliases for mobile fallback chain
    productId,
    id: p.id,
    type: p.type,
    typeLabel: label,
    code,
    slug,
    title: p.title,
    description: p.description,
    thumbnail: p.thumbnail,
    price: p.price,
    updatedAt: p.updatedAt,
    isActive: p.isActive,
    createdAt: p.createdAt,
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
    courseId: courseLegacyId,
    code,
    name: stripBrainboostLabel(p.title),
    description: legacyDescriptionExcerpt(p.descriptionHtml, p.description),
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

// FE NotificationModel — derive refTable/refId from payload when recognizable.
// Common payload shapes from notification.service produce {postId, commentId, ...}.
function deriveRef(payload: unknown): { refTable: string | null; refId: number | null } {
  if (!payload || typeof payload !== 'object') return { refTable: null, refId: null };
  const p = payload as Record<string, unknown>;
  // Pick first recognized id field. Order matters — most-specific first.
  if (typeof p.commentId === 'number') return { refTable: 'comments', refId: p.commentId };
  if (typeof p.postId === 'number') return { refTable: 'posts', refId: p.postId };
  if (typeof p.replyId === 'number') return { refTable: 'replies', refId: p.replyId };
  if (typeof p.memberId === 'number') return { refTable: 'members', refId: p.memberId };
  return { refTable: null, refId: null };
}

export function serializeNotification(n: Notification): Record<string, unknown> {
  const { refTable, refId } = deriveRef(n.payload);
  return {
    // FE NotificationModel — typed (int?, 0/1 ints, ISO strings, refTable+refId
    // for deep-link navigation).
    notificationId: n.id,
    title: n.title,
    message: n.body,
    isSeen: n.seenAt !== null ? 1 : 0,
    created: n.createdAt.toISOString(),
    updated: (n.readAt ?? n.createdAt).toISOString(),
    refTable,
    refId,
    type: n.type,
  };
}
