-- Sign in with Apple: stable per-app user identifier from the Apple identity
-- token `sub` claim. Nullable + unique, mirroring `google_sub`. Postgres treats
-- NULLs as distinct, so members without Apple linkage coexist freely.
ALTER TABLE "members" ADD COLUMN "apple_sub" TEXT;

CREATE UNIQUE INDEX "members_apple_sub_key" ON "members"("apple_sub");
