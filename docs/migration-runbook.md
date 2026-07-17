# Migration Runbook (legacy → new Postgres)

Ordered command list to migrate a **fresh** Postgres DB from the legacy MariaDB
(`tribelio_db`). Validated end-to-end on a trial DB (`bb_trial`). Brainboost-scoped:
only the data the new mobile app needs (≈58 courses, ≈57k members, 2 communities).

> Per-script analysis & decisions for the member step live in
> [`member-migration-plan.md`](./member-migration-plan.md).

## Hard rules
- **Do NOT** run the `members`, `products`, `networks`, `network-members`, `topics`,
  `posts`, `comments`, `post-likes`, `comment-likes` phases of `migrate-from-legacy.ts` —
  they are **superseded** by the dedicated scripts below. From `migrate-from-legacy` only
  run **`master`** and **`affiliate-programs`**.
- **Dependency order matters** (see each phase). Run phases in sequence.
- **Idempotent**: every script is safe to re-run (keyed on `legacyId` / `skipDuplicates`).
- **Legacy RDS resets** (`ECONNRESET`) on the two long scripts — `backfill-affiliate-tree`
  and `migrate:network-posts`. Just **re-run until `DONE`** (took 2 runs each on the trial).
- **Timezone**: legacy DATETIMEs are WIB wall-clock (UTC+7). `scripts/legacy-db.ts` sets
  mysql2 `timezone: '+07:00'` so Postgres stores UTC (= legacy −7h). A DB migrated **before
  2026-07-13** has `created_at` +7h off on members/enrollments/commissions/reviews/likes →
  fix once with `pnpm resync:fix-dates` (idempotent, re-reads legacy). Fresh migrations from
  this point are correct with no follow-up. Verify: any legacy wall-clock vs its Postgres
  `to_char(created_at, ...)` must differ by exactly 7h.

---

## 0. Setup
```bash
createdb <staging_db>
export DATABASE_URL=postgresql://USER:PASS@HOST:5432/<staging_db>
pnpm prisma migrate deploy        # build schema

pnpm seed:settings                # REQUIRED — affiliate cookieDays/holdDays + disbursement caps
pnpm seed:admin                   # admin login (if the admin app is used)
```
Env required: `LEGACY_DB_HOST/USER/PASS/NAME`. Optional: `LEGACY_RESOURCE_BASE`
(default `https://tribelio-s3-production.s3.ap-southeast-1.amazonaws.com` is correct),
`BUNNY_ACCOUNT_API_KEY` (only for media `copy`; `rewrite` does not need it).

## 1. Masters
```bash
pnpm migrate:masters              # countries, provinces, cities, districts, report-categories, banners
```

## 2. Products + courses
```bash
pnpm migrate:products             # 58 brainboost products (create-if-missing) + thumbnail + Course
pnpm migrate:course-sections
pnpm migrate:course-lessons
npx tsx scripts/migrate-all-media.ts rewrite --apply   # swap Bunny guids via media-guid-map.json (NO copy)
pnpm normalize:slides-data --apply                      # trim slides (AFTER media rewrite)
```
Skip: `backfill:product-selling-points` (no-op — migrate:products already fills it).
Skip: `migrate-all-media copy` (videos already in the new Bunny library).
**Order**: sections need products; lessons need sections; media `rewrite` MUST run **before**
`normalize` (normalize strips the iframe HTML that rewrite reads).

## 3. Affiliate programs
```bash
npx tsx scripts/migrate-from-legacy.ts affiliate-programs    # AffiliateProgram rows (course programs get productId=null)
pnpm backfill:affiliate-program-product                       # link 58 course programs to products + isActive=true
```

## 4. Members + enrollments + tree
```bash
pnpm migrate:members              # ≈57k members + ≈62k enrollments + profile bank account; writes scripts/member-redirect.json
npx tsx scripts/backfill-affiliate-tree.ts    # inviterId / affiliateBased / affiliateCode (reads redirect.json)  ← may ECONNRESET, re-run
pnpm migrate:member-affiliators   # MemberAffiliator join records (scoped, redirect-aware)
pnpm migrate:affiliate-commissions # ≈46k commissions as status=MIGRATED → drives currentTier/currentRate
pnpm migrate:kyc                   # legacy member_data_kyc → kycStatus + kycSource=LEGACY (APPROVED+REJECTED)
```
`migrate:members` must run before tree, affiliators, commissions, network-members, network-posts, reviews.
`migrate:kyc` runs after `migrate:members` (reads member-redirect.json; idempotent, guarded so re-runs
never clobber a MANUAL/SUMSUB decision). Source = legacy `member_data_kyc` (the real KYC table written by
tribelio-admin), NOT `member.last_kyc_status` (stale cache). APPROVED + REJECTED carried (latest row per
member, redirect-aware); PENDING skipped → those members re-KYC fresh via **Didit** (the provider since
2026-06-26; the `kycSource` flag value `SUMSUB` is legacy naming only). Backfills
`kycIdNumber=nik`, `kycReviewedAt=actionat`, `kycRejectedReason=reason`. Trial DB: ≈2.4k members
(APPROVED ≈1.5k, REJECTED ≈0.86k). Legacy KTP/selfie images live in legacy S3 and are NOT migrated.

**Bank account:** `migrate:members` carries `member.bank_account_*` (profile-level, rarely filled —
≈1.1k/704k). The real payout data lives on the **APPROVED `member_data_kyc` row** and is carried by the
**resync kyc syncer**, not by `migrate:kyc` — so after the resync tool is wired up (below), run
`pnpm resync kyc` to fill bank on the ≈4.2k members who have it. All bank writes are fill-if-NULL
(never overwrite an app-set account → never trips the BANK_CHANGE re-KYC).
`migrate:affiliate-commissions` runs after member-affiliators + backfill:affiliate-program-product.

**Commissions / tier (status MIGRATED):** `currentTier`/`currentRate` in `/affiliate/me/summary`
are derived from `lifetimeAmount = SUM(commission.amount WHERE status != VOIDED)`. Legacy
commissions migrate with status **MIGRATED** — they count toward lifetime/tier but NOT toward
withdrawable balance (status != BALANCE) and are never promoted by the PENDING→BALANCE cron
(status != PENDING). So legacy balance stays **0** while tier is correct; new post-migration
purchases use the normal PENDING→BALANCE flow. Non-brainboost products are not inserted
(productId/programId null; paymentLegacyId keeps the legacy payment ref).

## 5. Networks (the 2 BrainBoost communities)
```bash
pnpm create:bb-networks                       # BBTIMELN + BBEDUCAT networks (with codes)
npx tsx scripts/migrate-timeline-topics.ts    # topics for BBTIMELN
npx tsx scripts/migrate-education-tags.ts      # tags for BBEDUCAT
pnpm migrate:network-members
pnpm migrate:network-posts                     # posts + comments + replies + post/comment likes (HEAVY)  ← may ECONNRESET, re-run
```
`create:bb-networks` before topics/tags/members/posts.

## 6. Reviews
```bash
pnpm migrate:reviews              # product reviews (needs products + members)
```

## 7. IAP (optional)
```bash
pnpm seed:revenuecat-iap          # map iOS RevenueCat SKUs → Product.iosProductId
```

## 8. Ingest credential — RevenueCat (run last)
Issue the bearer credential the RevenueCat webhook uses to POST `/api/ingest/purchase`.
Prints the plaintext key **once** (only the hash is stored) — capture it and configure it
in RevenueCat. Re-running rotates the key.
```bash
pnpm issue:credential revenuecat --affiliate --refund
#   --affiliate → IAP purchases fire affiliate commission
#   --refund    → Apple/RevenueCat refund events auto-revoke enrollment + void commission
```

## 9. Hand off to the resync worker (transition period)
This runbook is a **one-shot** load. Legacy keeps being written to until each module is cut
over, so the migrated data goes stale immediately — the incremental resync tool takes over
from here. Spec: [`legacy-resync-plan.md`](./legacy-resync-plan.md).
```bash
pnpm resync:seed-redirect         # scripts/member-redirect.json → member_redirect table (once)
pnpm resync kyc                   # fills bank from APPROVED member_data_kyc (see §4)
pnpm resync --dry-run             # sanity check: counts only, no writes
pnpm resync                       # first full drain (all 7 syncers)
pnpm resync:worker                # then run continuously (RESYNC_INTERVAL_SEC, default 3600)
```
The syncers own **updates** to already-migrated rows; do NOT re-run `migrate:*` for that
(they are insert-only). `pnpm resync:unlock` clears a stale run-lock left by a hard-kill.

---

## Validated result (trial DB)
| Phase | Output |
|---|---|
| Masters | countries 295, provinces 49, cities 491, districts 5,547, reports 7, banners 10 |
| Products | products 58 (+thumbnail), courses 58, sections 67, lessons 207 |
| Affiliate prog | 12,335 programs; 58 brainboost linked + active |
| Members | members 57,432, enrollments 62,530, inviterId 16,315, affiliateCode 57,430, member-affiliators 15,845 |
| Networks | 2 networks, 14 topics, 6 tags, members 55,727, posts 7,193, comments 85,813, postLikes 47,970, commentLikes 9,825 |
| Reviews | 972 |
| IAP | iosProductId 54 |

## Known follow-ups (not part of this runbook)
- **Resilience**: add reconnect/retry to `backfill-affiliate-tree` + `migrate:network-posts`
  so an `ECONNRESET` resumes instead of restarting the full scan. (The resync worker already
  has this — `connectResilientLegacy`, `RESYNC_LEGACY_RECONNECT_RETRIES`; the one-shot
  migrate scripts still don't.)

**Resolved since this runbook was written:**
- ~~Affiliate commission flow needs a visit→program resolver~~ — done: `VisitService` resolves
  `programCode` → program, with a fallback that auto-picks when the affiliator is enrolled in
  exactly one active program (`affiliate.visit.registration.fallback_single_program`).
