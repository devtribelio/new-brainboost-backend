import type { Comment, Member } from '@prisma/client';
import { serializeMember } from '@/common/serializers/member-lite.serializer';
import { dateAgoString, timeAgoString } from '@/common/serializers/time-format';

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
    embedUrl: c.embedUrl ?? null,
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
    isCurated: c.isCurated,
    isDeleted: c.isDeleted,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    member: c.author ? serializeMember(c.author) : null,
  };
}
