import type { Comment, Member } from '@prisma/client';
import { serializeMember } from '@bb/common/serializers/member-lite.serializer';
import { dateAgoString, timeAgoString } from '@bb/common/serializers/time-format';

interface CommentWithAuthor extends Comment {
  author?: Member | null;
  /**
   * Thread root, resolved by `CommentService.detail()` — the one place routing
   * reads. Left undefined everywhere else, where `parentId` is the same answer
   * for every row at depth <= 2.
   */
  rootId?: string | null;
}

function parseMentions(content: string): string[] {
  const matches = content.match(/@[A-Za-z0-9_]+/g);
  return matches ? Array.from(new Set(matches.map((m) => m.slice(1)))) : [];
}

export function serializeComment(
  c: CommentWithAuthor,
  isLiked: boolean = false,
): Record<string, unknown> {
  const mentions = parseMentions(c.content);
  return {
    // FE CommentModel — primary fields
    commentId: c.id,
    replyId: c.parentId ?? null,
    postId: c.postId,
    memberId: c.author?.id ?? null,
    memberName: c.author?.fullName ?? null,
    memberProfileImage: c.author?.avatarUrl ?? null,
    embed: null,
    embedUrl: null,
    embedData: null,
    content: c.content,
    fullContent: c.content,
    image: null,
    audio: null,
    isLiked,
    timeAgo: timeAgoString(c.createdAt),
    dateAgo: dateAgoString(c.createdAt),
    countLike: c.countLike,
    countLikeInKilo: Math.round(c.countLike / 1000),
    replyCount: c.countReplies,
    mentions,
    // Backend-native extras (FE tolerates)
    id: c.id,
    parentId: c.parentId,
    // Id of the thread's top-level comment; null when this row IS that comment.
    // Same value as `parentId` for every row at depth <= 2 — it differs only on
    // the rows written before the depth cap, which is exactly when a client
    // routing a notification would otherwise open the wrong thread.
    rootCommentId: c.rootId === undefined ? (c.parentId ?? null) : c.rootId,
    images: [],
    isCurated: c.isCurated,
    isDeleted: c.isDeleted,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    member: c.author ? serializeMember(c.author) : null,
  };
}
