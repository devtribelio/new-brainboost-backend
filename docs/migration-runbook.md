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
pnpm migrate:members              # ≈57k members + ≈62k enrollments; writes scripts/member-redirect.json
npx tsx scripts/backfill-affiliate-tree.ts    # inviterId / affiliateBased / affiliateCode (reads redirect.json)  ← may ECONNRESET, re-run
pnpm migrate:member-affiliators   # MemberAffiliator join records (scoped, redirect-aware)
pnpm migrate:affiliate-commissions # ≈46k commissions as status=MIGRATED → drives currentTier/currentRate
```
`migrate:members` must run before tree, affiliators, commissions, network-members, network-posts, reviews.
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
- **Affiliate commission flow**: `commitCommissionsForPayment` requires a `programId`, but the
  app OneLink sends `product + affCode` with no program — needs a visit→program resolver, and a
  decision on the programId-required-vs-optional inconsistency. Programs are linked (step 3) but
  this gap means commissions may not fire yet. See member-migration-plan.md §7.
- **Resilience**: add reconnect/retry to `backfill-affiliate-tree` + `migrate:network-posts`
  so an `ECONNRESET` resumes instead of restarting the full scan.
