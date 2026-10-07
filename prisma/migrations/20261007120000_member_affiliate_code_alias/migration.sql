-- Affiliate codes of legacy dedup losers, re-pointed at the winner member.
-- Legacy dedup merged several accounts of one person into a winner; only the
-- winner's `member.affiliator_code` landed in members.affiliate_code, so links
-- shared under a loser's code resolved to nobody. Populated by
-- `pnpm resync:code-aliases`; read through resolveAffiliateCode (members first).
-- No row may hold a code that is also a members.affiliate_code (enforced by the
-- writers, not the DB: a constraint cannot span the two tables).
CREATE TABLE "member_affiliate_code_aliases" (
    "code" TEXT NOT NULL,
    "member_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_affiliate_code_aliases_pkey" PRIMARY KEY ("code")
);

CREATE INDEX "member_affiliate_code_aliases_member_id_idx" ON "member_affiliate_code_aliases"("member_id");

ALTER TABLE "member_affiliate_code_aliases" ADD CONSTRAINT "member_affiliate_code_aliases_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
