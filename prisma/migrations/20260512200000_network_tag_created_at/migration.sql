-- T2.4: Add createdAt to network_tags so `/api/member/network/tag` can emit
-- `created` per FE NetworkTagModel contract. Existing rows backfilled to
-- now() at column-add time (acceptable: tags' true creation timestamps were
-- not captured before this point).

ALTER TABLE "network_tags"
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
