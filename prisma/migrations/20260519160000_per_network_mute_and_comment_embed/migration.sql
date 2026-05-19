-- Per-network mute flag on NetworkMember + first-URL embed on Comment.
--
-- isMuted mirrors legacy TBApi::validateMemberMuteNetwork: a member can be
-- silenced inside a tribe (post/comment/like blocked) without losing
-- membership. Defaults false; populated later by an admin endpoint.
--
-- comments.embedUrl mirrors TBModel_Comment.embed_url. Stored at create time
-- from a regex match on content. Full OG metadata (title/desc/image) is
-- deferred — mobile fetches client-side.

ALTER TABLE "network_members"
  ADD COLUMN "isMuted" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "comments"
  ADD COLUMN "embedUrl" TEXT;
