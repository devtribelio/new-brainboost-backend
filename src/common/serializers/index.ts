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

export function serializeTopic(t: Topic & { isSubscribed?: boolean; countPost?: number; orderNumber?: number }): Record<string, unknown> {
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

export function serializePost(
  p: PostWithRelations,
  statusLike: 'like' | 'dislike' = 'dislike',
): Record<string, unknown> {
  return {
    postId: p.legacyId ?? p.id,
    id: p.id,
    memberId: p.author?.legacyId ?? p.authorId,
    networkId: p.networkId,
    topicId: p.topic?.legacyId ?? p.topicId,
    title: p.title,
    content: p.content,
    excerpt: p.excerpt,
    postType: p.postType,
    images: p.imageUrls,
    videoUrl: p.videoUrl,
    embedUrl: p.embedUrl,
    countLike: p.countLike,
    countComment: p.countComment,
    countReplies: p.countReplies,
    viewCount: p.viewCount,
    statusLike,
    isDeleted: p.isDeleted,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    member: p.author ? serializeMember(p.author) : null,
    topic: p.topic ? serializeTopic(p.topic) : null,
  };
}

interface CommentWithAuthor extends Comment {
  author?: Member | null;
}

export function serializeComment(
  c: CommentWithAuthor,
  statusLike: 'like' | 'dislike' = 'dislike',
): Record<string, unknown> {
  return {
    commentId: c.legacyId ?? c.id,
    id: c.id,
    postId: c.postId,
    memberId: c.author?.legacyId ?? c.authorId,
    replyId: c.parentId,
    parentId: c.parentId,
    content: c.content,
    images: c.imageUrls,
    countLike: c.countLike,
    countReplies: c.countReplies,
    statusLike,
    isDeleted: c.isDeleted,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    member: c.author ? serializeMember(c.author) : null,
  };
}

export function serializeCountry(c: Country): Record<string, unknown> {
  return {
    countryId: c.legacyId ?? c.id,
    id: c.id,
    name: c.name,
    code: c.code,
  };
}

export function serializeProvince(p: Province): Record<string, unknown> {
  return {
    provinceId: p.legacyId ?? p.id,
    id: p.id,
    countryId: p.countryId,
    name: p.name,
  };
}

export function serializeCity(c: City): Record<string, unknown> {
  return {
    cityId: c.legacyId ?? c.id,
    id: c.id,
    provinceId: c.provinceId,
    name: c.name,
  };
}

export function serializeDistrict(d: District): Record<string, unknown> {
  return {
    districtId: d.legacyId ?? d.id,
    id: d.id,
    cityId: d.cityId,
    name: d.name,
  };
}

export function serializeBanner(b: Banner): Record<string, unknown> {
  return {
    bannerId: b.legacyId ?? b.id,
    id: b.id,
    title: b.title,
    imageUrl: b.imageUrl,
    linkUrl: b.linkUrl,
    position: b.position,
    isActive: b.isActive,
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

export function serializeProduct(p: Product): Record<string, unknown> {
  const productId = p.legacyId ?? p.id;
  return {
    // Legacy field names (mobile ProductModel.fromAPIJson expects these)
    networkAccountProductAffiliatorId: productId,
    productType: p.type,
    productTypeLabel: productTypeLabel(p.type),
    productCode: productId,
    productSlug: deriveSlug(p.title),
    productName: p.title,
    productCategory: [],
    productPrice: p.price,
    productImageUrl: p.thumbnail,
    lastUpdated: p.updatedAt,
    productPaymentUrl: null,
    productShareDetailUrl: null,
    commisionFixAmount: null,
    productUrl: null,
    isPurchased: false,
    // Backend-native fields (extra, harmless to mobile parser)
    productId,
    id: p.id,
    type: p.type,
    title: p.title,
    description: p.description,
    thumbnail: p.thumbnail,
    price: p.price,
    isActive: p.isActive,
    createdAt: p.createdAt,
  };
}

export function serializeNotification(n: Notification): Record<string, unknown> {
  return {
    // Legacy field names (mobile NotificationModel)
    notificationId: n.id,
    title: n.title,
    message: n.body,
    isSeen: n.seenAt !== null,
    created: n.createdAt,
    updated: null,
    refTable: null,
    refId: null,
    type: n.type,
    // Backend-native (extras)
    id: n.id,
    body: n.body,
    payload: n.payload,
    seenAt: n.seenAt,
    createdAt: n.createdAt,
  };
}
