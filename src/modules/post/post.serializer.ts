import type { Member, Post, Topic } from '@prisma/client';
import { serializeMember } from '@/common/serializers/member-lite.serializer';
import { dateAgoString, timeAgoString } from '@/common/serializers/time-format';

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
    topicId: t.id,
    topicName: t.name,
    topicType: t.type,
    topicIcon: t.iconUrl,
  };
}

function buildPostCreator(m: Member | null | undefined) {
  if (!m) return null;
  // FE PostCreatorModel: `{memberId, name, profileImage, profileCoverImage}`.
  return {
    memberId: m.id,
    name: m.fullName,
    profileImage: m.avatarUrl,
    profileCoverImage: m.coverUrl,
  };
}

export function serializePost(
  p: PostWithRelations,
  isLiked: boolean = false,
  opts: { viewerId?: string; isJoined?: boolean | null } = {},
): Record<string, unknown> {
  const memberId = p.author?.id ?? null;
  const isAuthor = opts.viewerId != null && p.authorId === opts.viewerId;
  const baseUrl = process.env.PUBLIC_WEB_URL ?? 'https://brainboost.com';
  const postUrl = `${baseUrl}/post/${p.id}`;

  return {
    // FE PostModel — primary fields
    postId: p.id,
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
    isLiked,
    countLike: p.countLike,
    starred: null,
    countComment: p.countComment,
    timeAgo: timeAgoString(p.createdAt),
    dateAgo: dateAgoString(p.createdAt),
    topic: buildPostTopic(p.topic),
    canEdit: isAuthor,
    canDelete: isAuthor,
    pinned: p.isPinned ? 1 : 0,
    isCurated: p.isCurated,
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
    topicId: p.topicId,
    countReplies: p.countReplies,
    viewCount: p.viewCount,
    videoUrl: p.videoUrl,
    isDeleted: p.isDeleted,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    member: p.author ? serializeMember(p.author) : null,
  };
}
