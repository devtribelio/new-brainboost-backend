-- Does a Bunny copy of this asset exist? It decides whether `is_active = false`
-- is a ROLLBACK (Bunny serves it again) or an OUTAGE (nothing serves it).
--
-- true  — migrated from Bunny (every row before backoffice uploads), or an
--         upload whose master the job also pushed to Bunny.
-- false — an upload that lives only on our storage (no Bunny API key in that
--         env, guid minted locally, or the Bunny upload failed).
ALTER TABLE "media_audio_sources" ADD COLUMN "has_bunny_copy" BOOLEAN NOT NULL DEFAULT true;
UPDATE "media_audio_sources" SET "has_bunny_copy" = false WHERE "source_key" IS NOT NULL;
