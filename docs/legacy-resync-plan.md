# Legacy → Postgres Resync Plan

Recurring, incremental sync of already-migrated data from legacy MariaDB (`tribelio_db`)
into the new Postgres, for the **transition period** where legacy is still written to
(mobile clients hit legacy until each module is cut over).

> This is **not** "re-run the migration". The one-shot migration scripts (`migrate:*`)
> are insert-only (`createMany({ skipDuplicates })`) and only ever **add** net-new rows.
> Resync must **update** existing rows too, incrementally, without clobbering data the
> new system now owns. Migration runbook: [`migration-runbook.md`](./migration-runbook.md).
> Member scope/dedup rationale: [`member-migration-plan.md`](./member-migration-plan.md).

---

## 0. Implementation status (2026-06-24) — BUILT & VALIDATED on bb_trial

> **Code lives in `apps/resync-worker/`** (a throwaway transition tool, retired after
> cutover — delete the app dir + the four `resync*` root scripts). It was briefly a
> standalone sibling repo `bb-legacy-resync` (now archived) but was folded back in so it
> consumes the root `@prisma/client` + `@bb/common/utils/phone.util` directly — **no
> schema/util copy, no drift**. The `sync_state`/`member_redirect` tables +
> `members.legacy_synced_at` column (migration `20260624120000_add_resync_tables`) are part
> of the root schema. Run from repo root: `pnpm resync[:worker|:seed-redirect|:unlock]`.
> Paths below like `scripts/resync/*` now map to `apps/resync-worker/src/*`.

All 7 syncers implemented and validated end-to-end:
- Schema/migration deployed: `members.legacy_synced_at`, `sync_state`, `member_redirect`.
- `pnpm resync [syncer...] [--dry-run] [--since=]`, `pnpm resync:worker`,
  `pnpm resync:seed-redirect`, `pnpm resync:unlock` (clear a stale run-lock left by a hard-kill).
- **All 7 syncers real-run validated on bb_trial, errors=0**, and incremental confirmed on
  the second run (members 1, enrollments 0, kyc 0, tree 6, commissions 1, reviews 0, posts 4
  scanned). First-run upsert counts: members 57696, enrollments 62912, kyc 2382,
  tree 57079, commissions 46586 (voided 59), reviews 975, posts 95534 (posts+comments;
  likes mostly pre-existing → skipDuplicates count≈0).
- new-wins invariant verified: after a resync, `updated_at == legacy_synced_at` for all
  57696 winners → next run sees them untouched; an app write trips the gate. members run-2
  scanned=1 confirms `updated` does NOT bump on mere login.
- **Write concurrency (implemented 2026-07-09):** every syncer's per-row write loop now
  runs through `runConcurrent(rows, RESYNC_WRITE_CONCURRENCY, fn)` (worker-pool, default
  10) — the loops were RTT-bound on a remote Postgres (first live run on bb_backend ≈4-5h
  at 1 sequential write/row). Safety under concurrency:
  - `ensureMember` has an in-flight promise memo (one create per legacyId, no
    double-create) and stamps `updatedAt = legacySyncedAt` from the SAME `Date` at
    create/adopt so the members touch-gate can't misread a fresh row (ms skew).
  - pair-keyed tables (enrollments, member_affiliators) read-decide-**claim** their
    in-memory pair map in one synchronous block → same-pair rows can't race a create.
  - tree inviters / reviews dedupe to the newest row per subject before the parallel
    write (deterministic last-write-wins instead of by-chance ordering).
  - checkpoints still fire only after the whole page/syncer settles → watermark semantics
    across runs unchanged; per-row errors stay isolated (each op try/catches itself).
- **Watermark overlap lag (implemented):** stored watermarks are pulled back
  `RESYNC_WATERMARK_LAG_SEC` (default 60) via `sinceBound()`. Legacy `updated` is assigned
  at PHP save() time but only becomes visible at COMMIT — a strict `>` could permanently
  skip rows that commit late or share the boundary second. The overlap re-scan is free
  (all writes idempotent). Implements the mitigation described under "Watermark format".
- **New-member backfill (implemented):** members materialised on demand by `ensureMember`
  mid-run have pre-existing legacy rows elsewhere whose `updated` already fell behind the
  kyc/tree/commissions watermarks → those scans would never revisit them. After the syncer
  loop, `backfill-new-members.ts` re-scans (IN-list, since=epoch, widened to dedup losers)
  kyc decisions, inviter chain (winner-scoped), program memberships, received commissions
  (incl. non-BB rows that count toward lifetime tier) and given likes for JUST the new
  ids. Surfaced as the `backfill` entry in run stats; triggers a recount when it wrote.
- **Community auto-join (implemented 2026-07-31):** BrainBoost has exactly two community
  networks (`networks.purpose` = `timeline` + `education`) and EVERY member belongs to
  both — mandatory, not derived from legacy `network_member` (same rule as the one-shot
  `scripts/migrate-network-members.ts`). The app enforces it at registration
  (`AuthService.autoJoinCommunityNetworks`), but a member created by `ensureMember` never
  passes through that path, so until now resync-materialised members had NO `NetworkMember`
  row: `/network` (my networks) empty, notification fan-out skips them, and every write
  path (post / comment / like) 403s `NETWORK_MEMBERSHIP_REQUIRED` — only feed *reads* kept
  working, because both networks are public. `network-join.ts::joinCommunityNetworks` now
  runs as the last step of the new-member backfill: `createMany({ skipDuplicates })` against
  `@@unique([networkId, memberId])` (an adopted app placeholder that already joined is a
  no-op), `joinedAt = member.createdAt`, then `count_member += inserted`.
  **Existing stock** (members resync created before this): re-run the idempotent
  `pnpm tsx scripts/migrate-network-members.ts` — it cross-joins every `legacyId != null`
  member × both networks and recomputes `count_member`.
- **networks.count_member in recount (2026-07-31):** `recountCounters` now also rebuilds
  `networks.count_member` from `network_members` (reset-then-aggregate, same shape as the
  post/comment counters), so the column self-heals after any out-of-app write — the
  auto-join above, a manual SQL backfill, or the one-shot migrate script.
- **Lock heartbeat (implemented):** the run refreshes the `__lock__` stamp after each
  syncer **and on a timer while a syncer runs** (`lockTtlSec/3`, min 30s — a syncer's only
  checkpoint is at its end, and the first members/posts pass can exceed the TTL), so a run
  longer than the TTL (4-5h first run vs 2h default) can't be taken over mid-write; a lost
  heartbeat aborts the remaining syncers instead of double-writing.
- **members raw UPDATE tz fix (implemented):** `updated_at`/`legacy_synced_at` are now an
  app-side `Date` param (was server `now()`): the columns are tz-less `timestamp` filled
  with app-clock UTC by Prisma everywhere else — a non-UTC server TimeZone or app↔DB
  clock skew would have corrupted the touch-gate comparison.
- **fix-dates covers likes too (2026-07-09):** `post_likes`/`comment_likes.created_at`
  added to `pnpm resync:fix-dates` (mapped by composite key) — `createMany skipDuplicates`
  never re-touches an existing like, so pre-tz-fix likes were otherwise stuck +7h.
  Still pending on bb_backend: run fix-dates once AFTER the in-flight first run finishes
  (posts/comments self-heal via the posts syncer's upsert-update; members/enrollments/
  commissions/reviews/likes need the script).
- **Bank account carry (2026-07-13):** legacy payout-account data now flows on all three
  member paths, always fill-if-NULL (never overwrites an app-set account → never trips the
  BANK_CHANGE re-KYC): ① `migrate-members.ts` + ② resync `ensureMember` (create/adopt) copy
  `member.bank_account_bank/number/name` (profile-level, rarely filled: ~1.1k/704k); ③ the
  kyc syncer's `applyKycDecisions` fills bank from the latest **APPROVED** `member_data_kyc`
  row (`bank_type`=bank code, **`bank_name`=ACCOUNT HOLDER name**, `bank_number`=account
  number — legacy naming trap), independent of the kycSource guard (bank data is
  provider-agnostic). Backfill for the existing stock = `pnpm resync:reset-watermark kyc &&
  pnpm resync kyc` (re-evaluates everyone through the bank-aware path).
- **Stale-lock gotcha:** a hard-killed run (SIGKILL / host teardown) can't run its
  release finally-block, so `__lock__` stays held until the TTL (`RESYNC_LOCK_TTL_SEC`,
  default 2× interval = 2h). `pnpm resync:unlock` clears it immediately. Graceful SIGTERM
  on the worker is fine (it finishes the tick, finally releases).

**Deviations from the design below (intentional):**
- Syncer interface is a single `run(ctx)` returning `Stats` + `ctx.checkpoint(wm)` for
  per-batch watermark, instead of the illustrative `fetchChanged/upsert/nextWatermark`
  triple — lets multi-pass syncers (posts) share one watermark cleanly.
- **posts** keeps the migrate `status=1 AND is_active=1` filter, so post/comment
  *hard-deletes* are NOT propagated (added to the residual-gap list, alongside un-likes).
  Edits to live posts/comments still ride the watermark.
- **members** overwrites only `fullName/avatarUrl/bio/isActive`; `gender/birthdate` deferred.
- Run-lock is a TTL row in `sync_state` (`__lock__`), not a pg advisory lock (portable,
  crash-safe, no connection-pinning issues).

---

## 1. Scope

**In scope (synced):** members, course enrollments, affiliate commissions, KYC,
affiliate tree / member-affiliators, reviews, network posts + descendants (comments,
replies, post-likes, comment-likes).

**Out of scope (NOT synced):** products, courses, sections, lessons, media, masters
(countries/cities/banners/report-categories). These change rarely and are handled by
re-running the dedicated `migrate:*` scripts on demand, not by the cron.

---

## 2. Run model (decided)

- **Uniform cadence** ("rata") — every syncer runs every tick; no per-syncer interval.
- **Interval is an env var** so it's trivial to change: `RESYNC_INTERVAL_SEC` (default `3600`).
- **One core function `runResync()`**, two entrypoints sharing it:
  - **Worker (prod):** `pnpm resync:worker` — loop: open fresh legacy+PG connections →
    run all syncers → close connections → sleep `RESYNC_INTERVAL_SEC` → repeat.
    Change cadence = edit env + restart. Mirrors the existing `relay:comms` worker.
  - **CLI (manual/debug):** `pnpm resync [syncer...] [--dry-run] [--since=ISO]` — one shot, exit.
- Connections are opened/closed **per tick** (not held) → survives legacy RDS `ECONNRESET`.
- If OS cron is ever preferred instead, point it at the CLI (`pnpm resync`); the worker
  simply goes unused. Both share `runResync()`, so no wasted work.

### Env vars
| Var | Default | Meaning |
|---|---|---|
| `RESYNC_INTERVAL_SEC` | `3600` | Worker loop interval. |
| `RESYNC_SYNCERS` | `all` | `all` or CSV subset (`enrollments,kyc,...`). |
| `RESYNC_BATCH_SIZE` | `1000` | Rows per upsert batch / chunk. |
| `RESYNC_WRITE_CONCURRENCY` | `10` | Max Postgres writes in flight per syncer (keep ≤ Prisma pool size). |
| `RESYNC_WATERMARK_LAG_SEC` | `60` | Overlap window subtracted from a stored watermark on the next run. |
| `RESYNC_LEGACY_RECONNECT_RETRIES` | `3` | Reconnect attempts on `ECONNRESET` within a run. |

Reuses existing `LEGACY_DB_*` creds via `scripts/legacy-db.ts`.

---

## 3. Watermark: every legacy table has `updated` (verified)

**Verified against `tribelio_db`** (2026-06): *every* source table carries the Cresenity
audit quad `created / createdby / updated / updatedby` (`updated` is `datetime`). The
existing `migrate:*` scripts simply never SELECT-ed `updated` — it's there. Relevant
soft-delete / change columns also confirmed:

| Legacy table | Watermark | Soft-delete / change signal |
|---|---|---|
| `member` | `updated` | `date_deleted`, `date_deleted_schedule`, `last_active` |
| `course_enrollment` | `updated` | — |
| `affiliator_commision` | `updated` | `is_expired` |
| `member_data_kyc` | `updated` (`actionat`) | review fields |
| `member_product_affiliator` | `updated` | `deleted`, `delete_at`, `exit_date`, `exit_state` |
| `member_network` | `updated` | parent_id / affiliate_based |
| `post` | `updated` | `publish_status`, `archieved_at`, `last_edited_at` |
| `comment` | `updated` | `deleted` |
| `like` (post & comment) | `updated` | (unlike = **hard delete** — see gap below) |
| `product_review` | `updated` | — |

**Consequence — all syncers are `incremental`:**
```sql
WHERE COALESCE(updated, created) > :watermark
ORDER BY COALESCE(updated, created), <pk>
```
- `COALESCE(updated, created)` because `updated` is NULL on rows never modified since
  insert — fall back to `created` so they're still picked up on first run.
- This catches **inserts, edits, AND soft-deletes** in one pass — soft-deletes go through
  the legacy model's `save()` which bumps `updated` (Cresenity convention), so a
  `comment.deleted` / `member.date_deleted` / `affiliator.deleted` set re-surfaces the row
  with a fresh `updated`. The earlier "append-only, edits not captured" concern and the
  separate reconcile-sweep are therefore **not needed**. Each syncer maps the soft-delete
  signal to the new side (`isDeleted` / `isActive=false` / commission `VOIDED`).

**Residual gap — likes (unlike):** a legacy *unlike* is a hard `DELETE` of the `like` row,
so the deletion can't ride an `updated` watermark (the row is gone). New likes/edits sync
fine; **un-likes do not propagate**. Logged explicitly. (A periodic full diff of like rows
could close this later if it matters — low stakes, deferred.)

**Watermark format:** stored as the ISO datetime string of `max(COALESCE(updated,created))`
in the batch. To avoid skipping rows that share the boundary second, the next query uses
`>= :watermark` combined with a processed-PK guard, or `> :watermark` with a 1-second
overlap re-scan (cheap, upsert is idempotent so re-processing a few boundary rows is safe).

**Checkpoint rule (2026-10-06, `WatermarkTracker` in `apps/resync-worker/src/util.ts`):**
`checkpoint = min(maxSeen, runStart, earliestFailed − 1s)`, and **no checkpoint at all when
nothing was scanned**. `runStart` = legacy clock (`legacyNow()`: `UTC_TIMESTAMP()` rendered in
`LEGACY_DB_TIMEZONE`, so it decodes like an `updated` value) read before the syncer's first
query — a row changed in an already-scanned chunk / sub-query / table during a long run is
re-scanned next tick instead of skipped. A row whose WRITE threw holds the checkpoint below
it (logged `ERROR write <pk>=<id>: <code>`, code only — no row data); intentional skips
(out of scope, guard-blocked, known P2002 collisions) still advance. Consequence: a row that
fails on every run pins its syncer — each tick re-scans from that row onward (idempotent,
but slower) and logs the same `ERROR write` line; fix the cause, or move the watermark past
it by hand (`UPDATE sync_state SET watermark = … WHERE syncer = …`). A `--since` newer than
the stored watermark never moves it forward (the gap below `--since` was not scanned), so it
cannot be used to skip ahead. `checkpoint()` also refreshes the run-lock heartbeat and stops
the syncer if the lock was taken over.

---

## 4. New schema (additive — hand-written SQL + `prisma migrate deploy`)

> **Gotcha:** never `prisma migrate dev` on a populated DB (`bo_roles`/`bo_users` drift →
> it tries to DROP them). Hand-write the migration SQL, then `prisma migrate deploy`.

### 4.1 `sync_state` — per-syncer watermark + stats
```prisma
model SyncState {
  syncer        String   @id                       // "enrollments" | "commissions" | ...
  watermark     String?                             // max processed value (ISO date or numeric PK as text)
  lastRunAt     DateTime? @map("last_run_at")
  lastStats     Json?     @map("last_stats")         // { scanned, upserted, skipped, errors }
  updatedAt     DateTime @updatedAt @map("updated_at")
  @@map("sync_state")
}
```

### 4.2 `member_redirect` — durable dedup loser→winner (replaces `scripts/member-redirect.json`)
```prisma
model MemberRedirect {
  loserLegacyId  Int      @id @map("loser_legacy_id")
  winnerLegacyId Int      @map("winner_legacy_id")
  createdAt      DateTime @default(now()) @map("created_at")
  @@index([winnerLegacyId])
  @@map("member_redirect")
}
```
On first deploy, seed it from the existing JSON file (one-off import). Every resync run
loads it into memory to re-point dangling legacy member refs.

### 4.3 `members.legacy_synced_at` — for new-wins-on-touch (members only)
```prisma
// add to Member
legacySyncedAt DateTime? @map("legacy_synced_at")
```

---

## 5. Syncer framework

```ts
interface Syncer {
  name: string;
  mode: 'incremental' | 'append';
  // pull legacy rows changed since the stored watermark, in PK/updated order, batched
  fetchChanged(legacy: Connection, since: string | null, limit: number): Promise<LegacyRow[]>;
  // upsert into Postgres with per-field ownership guards; returns stats
  upsert(rows: LegacyRow[], ctx: Ctx): Promise<Stats>;
  // the new watermark given the processed batch (max COALESCE(updated,created))
  nextWatermark(rows: LegacyRow[], prev: string | null): string | null;
}
```
All syncers are `incremental` (§3) — inserts, edits, and soft-deletes all ride the
`updated` watermark, so no separate reconcile pass is required.

`runResync(syncerNames, opts)`:
1. `pg_try_advisory_lock(<resync key>)` — bail immediately if a previous run holds it (anti-overlap).
2. Load `member_redirect` map + legacyId→uuid maps needed by ctx.
3. For each syncer in **dependency order** (§7): loop `fetchChanged → upsert → advance
   watermark`, batch by `RESYNC_BATCH_SIZE`, commit watermark **per batch** (so an
   `ECONNRESET` mid-run resumes, never restarts).
4. Write `sync_state` stats; release advisory lock. One syncer failing is caught and
   logged; it does not block the others.

Layout (`scripts/resync/`):
```
scripts/resync/
  run.ts                # CLI entry (one-shot)
  worker.ts             # loop entry (reads RESYNC_INTERVAL_SEC)  ← pnpm resync:worker
  core.ts               # runResync(), advisory lock, watermark, batching
  syncers/
    members.ts  enrollments.ts  commissions.ts  kyc.ts
    tree.ts  reviews.ts  posts.ts   # posts.ts handles comments+replies+likes
  mappers/              # legacy-row → new-row transforms shared with migrate:* scripts
```
**Extract** the transform logic currently inlined in the `migrate-*` scripts into
`mappers/` so the initial migration and the resync share one code path (no drift). The
`migrate:*` scripts then become "mapper + createMany"; resync = "mapper + upsert + guard".

---

## 6. Ownership / guard rules per entity (the safety core)

Legacy is authoritative **only** for rows it still owns. Guards prevent clobbering
new-system state.

### members — **new-wins-on-touch**
- Only touch rows with `legacyId != null`. Rows with `legacyId = null` (registered in the
  new app) are **never** touched.
- **Per-field gate on app-edit markers (2026-10-06, replaces the `updatedAt > legacySyncedAt`
  touch-gate).** `updatedAt` is Prisma `@updatedAt` — every write bumps it (push counters,
  `lastActiveAt`, `lastTopicDigestAt`, the resync's own tree/kyc writes) — so 64,360/64,366
  migrated members read as touched and legacy password/profile/reactivation stopped flowing
  (1,004 members locked out of a legacy-reset password). Now `members.profile_updated_at` /
  `password_updated_at` are set ONLY by member-initiated app edits (profile update;
  change-password, forgot-password reset, claim), and `planMemberSync`
  (`apps/resync-worker/src/syncers/member-rules.ts`) decides per field:
  - profile (`fullName`/`avatarUrl`/`bio`) → overwritten while `profile_updated_at IS NULL`;
  - password → overwritten while `password_updated_at IS NULL` (NULL legacy password never
    clobbers). The lazy md5→bcrypt rehash on login does NOT set the marker (same password);
  - `isActive` → follows legacy both ways, except no reactivation over an app
    `scheduledDeletionAt`.
  `legacySyncedAt` is still stamped (provenance only). Migration
  `20261006120000_member_app_edit_markers` backfills the markers only for app-active
  (`last_active_at` not null) legacy members (password: only bcrypt rows) — a member who
  never opened the app follows legacy.
- **Legacy-owned fields**: `fullName`, `avatarUrl`,
  `bio`, `isActive` (from `is_active && !is_deleted`),
  `passwordHash`/`passwordAlgo` (see below).
- **Never legacy-owned** (app or other syncers own these):
  `email`/`phone`/`*Verified` (identity — touching unique cols on a live account is risky;
  leave to a deliberate later pass), all `kyc*`, all `bank*`, `affiliateCode`/`code`,
  `inviterId`/`affiliateBased` (owned by the **tree** syncer).
- **Password (2026-08-21):** legacy still accepts registrations + resets during cutover, so
  `member.password` is propagated until `password_updated_at` is set by an app password
  write (see the per-field gate above). A NULL/empty legacy password is a no-op (`COALESCE`), never a
  clobber of a real hash with the social sentinel. **`passwordAlgo` is DERIVED from the hash
  shape** (`detectPasswordAlgo`, `@bb/common/utils/password-algo.util`), never assumed — see
  §6.1.
- **The members syncer only WATCHES already-migrated members for changes** — it does NOT
  discover new members. It scans `member_id IN (our migrated legacyIds)` (PK-indexed,
  chunked 5000) + the `updated` watermark, NOT the whole ~700k legacy `member` table. The
  old full-table scan fetched ~575k rows per run only to discard ~528k out-of-scope ones
  (90s); the scoped scan is ~1s. Same for the **tree inviter** pass (`member_network` is the
  GLOBAL affiliate tree — scoped to migrated `member_id IN`, never creates).
- **New legacy members ARE created on demand** (`ctx.ensureMember`, `ensure-member.ts`),
  but **ONLY from brainboost-scoped paths** — this is the scope guard. `ensureMember` is
  called for: enrollments enrollee (`BB_COURSES`), commissions recipient **only when the
  commission is for a brainboost course** (`productId !== null`), tree **affiliator** member
  (`napa IN` linked BB programs), posts/comments author (`network_id IN` BB networks),
  reviews member (BB product). Everywhere else uses `resolveMember` (attach-if-exists, never
  create): commission `buyerMemberId`, non-BB commission recipients, the tree **inviter**
  subject, likes. **Why it matters:** the tree inviter pass and non-BB commissions touch the
  whole legacy base; calling `ensureMember` there would materialise all ~700k legacy members
  (scope blowout). Creation must only fire where the row itself proves brainboost scope.
- **Incremental dedup (in `ensureMember`):** same junk/no-identity filters + email/phone/
  `@brainboost.id`→null normalisation as `migrate-members.ts`. Existing winners are
  **frozen** (never re-ranked). On create: identity collides with an existing winner
  (`legacyId` set) → write `member_redirect` (loser→winner), return the winner; collides
  with a new-app placeholder (`legacyId=null`) → **adopt** it (stamp `legacyId` + profile);
  no collision → fresh create. The in-run `redirect`/`memberByLegacy` maps are mutated so
  later syncers resolve the new id; counts logged as `created/redirected/adopted`.
- **Redirect resolution is transitive (2026-10-06).** `member_redirect` is normally one hop,
  but a manual seed or a split/merge can leave A→B→C; `flattenRedirects` (`util.ts`, applied in
  `core.ts`, `fix-dates.ts`, `identity.ts`, `code-aliases.ts`) collapses every chain to its
  terminal winner (and folds a cycle onto one node) so a loser never resolves to an
  intermediate loser that has no member row.

### 6.1 `passwordAlgo` is derived from the hash, never assumed

Measured on the live legacy `member` table (710k rows): **462,059 md5**, **248,328 NULL**,
**440 bcrypt** (`$2y$10$…`, 60 chars). Legacy writes md5 in every code path we can see
(`TBMember.php:1053`, `tribelio-admin/member.php:252`), but a few hundred rows carry a PHP
`password_hash()` digest.

Every writer used to stamp `passwordAlgo: legacyPassword ? 'legacy' : 'social'` blind.
`'legacy'` is the **md5 alias** in `AuthService.verifyPassword`, so a bcrypt-hashed member
gets `md5(plaintext)` compared against `$2y$…` — never a match, **permanent lockout with the
correct password**. 57 such rows already existed in Postgres when this was found.

Fix: `detectPasswordAlgo(hash)` maps shape → algo (`$2[aby]$NN$` → `bcrypt`, 40 hex →
`sha1`, 64 hex → `sha256`, everything else including md5 → `legacy`, null/empty → `social`).
Wired into all four creators — `ensure-member.ts`, `identity.ts`, `scripts/migrate-members.ts`,
`scripts/migrate-from-legacy.ts` — plus the members syncer's raw UPDATE.

Existing rows are repaired once by `pnpm resync:fix-password-algo [--dry-run]`: it re-derives
the algo for every non-`social` member and rewrites only the mismatches. It deliberately does
**not** bump `updated_at` — this corrects metadata about an unchanged hash, and a bump would
trip the touch-gate and freeze that member's profile against legacy forever. `social` rows are
excluded outright so a social-only account can never acquire an algo that authenticates.

### enrollments — incremental, low risk
- Key `legacyId`; also dedupe on `@@unique([memberId, courseId])`. Upsert. Access rule
  identical to migration (payment SUCCESS or free). Re-point `member_id` through
  `member_redirect`. Skip if course not in the migrated 58 or member out of scope.
- No new-system conflict (new purchases create their own enrollments with `legacyId=null`).
- **Legacy removal propagates as a cancel (added 2026-09-14).** `course_enrollment` has
  **no `deleted` column**, so the Cresenity soft-delete marks removal with `status = 0`
  (and bumps `updated`, which is what rides the row into the scan). Two things reach it:
  the free-trial expiry cron
  (`TBTaskQueue_Payment_Product_CourseEnrollmentExpiredFreeTrial`, every minute, LIMIT 10)
  and a manual removal. The syncer now sets `isCanceled = true` +
  `cancelationReason = 'legacy_removed'` instead of importing the row as a live
  enrollment — a cancel, never a row delete, so `progress` survives exactly as it does
  for a refund.
  - Handled **before** the payment/access check: a removal is true regardless of what the
    payment row says now.
  - Uses `resolveMember`, not `ensureMember` — a removal is no reason to materialise a
    member who has no row here yet.
  - Only cancels the row that *this* legacy row created (`existing.legacyId === legacyId`).
    A pair now held by a different legacyId (member re-enrolled) or by a new-system
    purchase (`legacyId = null`) is not the syncer's to revoke.
  - Guarded on `isCanceled: false`, so a re-scan is a no-op rather than re-stamping
    `canceled_at`. Counted in `stats.voided`.
  - Measured at the time of the change: 3 508 legacy rows with `status = 0`, of which
    **3 507 passed the access filter** and were being imported as live enrollments.
    Dry-run of the fix over a full rescan: `voided=3240` (the rest resolve to no
    matching row). 114 of them were expired free trials.
- **Repair for rows already imported:** the soft-delete bumped `updated` in the *past*,
  so those rows sit below the stored watermark and will never be rescanned. Force one
  full pass — no new script needed:
  ```
  pnpm resync enrollments --dry-run --since=1970-01-01T00:00:00Z   # count first
  pnpm resync enrollments --since=1970-01-01T00:00:00Z
  ```
- **Re-enrolment, cancel guard, reactivation, scope (fixed 2026-10-05).** Legacy writes a
  NEW `course_enrollment` row (new legacyId) when a member re-enrols — typically buying
  after the free trial expired. The pair here was still held by the old legacyId, so the
  new row was skipped and the later removal of the old row cancelled a paying buyer
  (measured: 53 paid enrollments / 8 members cancelled 2026-09-29). Rules now in
  `apps/resync-worker/src/syncers/enrollment-rules.ts` (table-driven spec in
  `apps/resync-worker/tests/`):
  - **Re-point:** an active incoming row whose pair is held by a *different* legacyId that
    is cancelled or past `expired_date` takes over that PG row (`legacyId` = new,
    un-cancelled, `expiredDate` = new row's, `progress` = max). A live row or a new-system
    row (`legacyId = null` — app purchase, employee grant) is still skipped.
  - **Cancel guard:** a `status = 0` row cancels only if it holds the pair AND legacy has no
    other active (status 1 + access) row for that course on any redirect-linked legacy
    member id AND the member has no `PAID` `commerce_transactions` order for the course's
    product.
  - **Reactivation:** same legacyId back to `status = 1` lifts a `legacy_removed` cancel
    (never a refund cancel).
  - **Scope:** `course.client = 'brainboost'` OR a SUCCESS `course_payment` with
    `client_product = 'brainboost'` (course 6659 has `client` NULL). In-scope courses with
    no PG `Course` row are logged each run (`in-scope legacy courses with no PG course`).
  - Heal = the same full pass as below (dry-run first).
- **`is_canceled` is deliberately NOT mapped.** The legacy column exists but is never
  written: 0 rows carry `is_canceled = 1`. `status` is the real cancel marker.
- `expired_date` is copied as-is and now *means something* on this side: access gates
  honour it (`activeEnrollment()`), so a legacy free trial expires here too. See
  `docs/commerce-port.md` §8b — the enrollment-migration script (`migrate-members.ts`)
  carries the same `status = 1` filter.

### commissions — incremental
- Insert/update legacy `affiliator_commision` rows as `status='MIGRATED'`, key `legacyId`,
  honor `@@unique([paymentId, recipientId, level])`. **Only ever touch `status='MIGRATED'`
  rows** — never PENDING/BALANCE/VOIDED (owned by the new Xendit flow).
- `is_expired=1` now rides the `updated` watermark → set the matching `MIGRATED` row to
  `VOIDED` in the same pass (keeps `currentTier`/`lifetimeAmount` honest; lifetime excludes
  VOIDED). No separate sweep needed.

### kyc — incremental, guarded
- Source `member_data_kyc` latest row per member, `WHERE COALESCE(updated,created) > :watermark`.
- Carry APPROVED + REJECTED only (PENDING skipped → Sumsub). Guard
  `kycSource IN ('NONE','LEGACY')` — never clobber a `MANUAL`/`SUMSUB` decision, and
  never downgrade an `EXPIRED` (re-KYC in progress). Backfill `kycIdNumber/kycReviewedAt/
  kycRejectedReason` as the migrate script does.

### tree (inviter / member-affiliators) — incremental
- `member_network` parent links → `inviterId` + `affiliateBased` + `affiliateCode`;
  `member_product_affiliator` → `MemberAffiliator` rows (key `legacyId`, `@@unique
  [memberId, programId]`). Re-point through `member_redirect`.
- `member_product_affiliator.deleted / exit_date / exit_state` rides the `updated`
  watermark → deactivate the join row in the same pass.
- **Inviter ownership = `members.inviter_source`** (migration `20261006130000_member_inviter_source`,
  2026-10-06): `LEGACY_PARENT` (tree resync) | `LEGACY_CONNECT` (reserved for the
  `member_network_connect` sync, PRD P0-1) | `APP` (register / pre-reg carry-over / social /
  `affiliateConnect`) | NULL (no inviter / unknown). The tree pass writes `inviterId` only over
  NULL or `LEGACY_PARENT` (atomic `updateMany` gate), stamps `LEGACY_PARENT`, and **never writes
  NULL over a non-null inviter** — a legacy row with no parent leaves the value alone. Before this
  the pass overwrote app-set inviters unconditionally, including to NULL (audit 07 #5).
- **Self / cycle guard** (`inviter-rules.ts`, PRD P0-4): a parent that is a dedup-loser alias of
  the subject resolves to the subject itself (legacy 424829 → itself, real upline 57). The pass
  climbs past such aliases (≤ 5 hops) to the first ancestor that is someone else; still self →
  clear a stored self-inviter + `WARN inviter self`. A candidate whose own 4-level `inviter_id`
  chain reaches the subject is rejected (`WARN inviter cycle … left as is`) — an already stored
  mutual pair (641626 ↔ 641123) is therefore NOT auto-repaired; decide by hand.
- `scripts/backfill-affiliate-tree.ts` is disabled (exits 1): it wrote NULL inviters and read the
  stale redirect JSON. Use `pnpm resync tree`.

### programs — incremental (PRD P1 #11)
- `network_account_product_affiliator` (`productable LIKE '%Course%'`, in-scope BB courses) →
  `AffiliateProgram` keyed `legacyId`, same shape as `migrate-from-legacy.ts::migrateAffiliatePrograms`
  + `backfill-affiliate-program-product.ts` (`PROG-<id>`, napa name, product via
  `Course.legacyCourseId`, `isActive=true`). Creates missing programs and links an unlinked one;
  never re-activates/renames/re-points a linked program. No product → logged, never created.
- Runs **before tree** (tree only syncs joins of linked programs). Joins of a newly linked
  program predate the tree watermark → after a run that logs `program(s) newly linked`, force
  `pnpm resync tree --since=1970-01-01T00:00:00Z` once (dry-run first).

### connect — incremental (PRD P0-1, option C decided 2026-10-06)
- `member_network_connect` → `inviter_id` with source `LEGACY_CONNECT` (`syncers/connect.ts`,
  rules in `connect-rules.ts`; `CONNECT_VARIANT = 'C'`), runs after `treeSyncer`. Option C:
  a member whose connect differs from its legacy parent AND has downlines keeps the parent
  (WARN `downlines`, review list) so L2–L4 of its downlines match legacy; never flipped back
  once applied. Tree never overwrites `LEGACY_CONNECT`; connect never overwrites `APP`.
- Removal (status=0) reverts a `LEGACY_CONNECT` inviter to the resolved legacy parent
  (`LEGACY_PARENT`); no usable parent → cleared only if it still equals the removed connect.

### pra-members — NOT synced (decided 2026-10-06)
- Legacy `pra_member` is dead: `MemberPraRegister` is `@deprecated 2.5`, the table holds
  1 267 rows and the newest was created 2020-06-19. A carry-over window of any sane length
  (30 days) would never match a row, so no syncer and no `PraMember.legacy_id` column were
  added (audit P2 "pra_member.ref_id tidak di-sync" closed as not needed).

### reviews — incremental
- `product_review` `WHERE status=1 AND productable_type='TBModel_Course' AND
  COALESCE(updated,created) > :watermark`, upsert on `@@unique(productId, memberId)`. The type
  filter is required: a Bundle/Digital/Book review can share a numeric `productable_id` with a
  migrated `Product.legacyId`. Needs product + member to exist (skip otherwise).
- **Gap:** `Review` has no legacyId/app-edit marker, so a re-scan overwrites `stars`/`comment`
  an app user edited — needs a provenance column before it can be guarded.

### posts + comments + replies + likes — incremental
- Reuse `migrate-network-posts` upsert-by-`legacyId` logic (already upserts).
- `post` / `comment` (incl. replies via `reply_id`→`parentId`) keyed by `legacyId`,
  watermarked on `updated`. Edits, `publish_status` changes, and `comment.deleted` soft
  deletes all ride the watermark → map to `publishStatus` / `isDeleted`.
- `like` (post & comment) keyed by `@@unique([postId|commentId, memberId])` — **no
  legacyId**, so dedupe on the composite; new likes ride `updated`, but **un-likes (hard
  delete) do not propagate** (logged — see §3 residual gap). The `like` table has no
  `network_id`, so it is scoped SQL-side by `post_id IN (BB posts)` / `comment_id IN
  (BB comments)` (legacy ids from the new DB, chunked) — **never a full-table scan** of
  every tribelio like.
- Two-pass comments (top-level then replies) preserved so `parentId` resolves.
- **Denormalised counters NOT maintained by the syncer.** Posts/comments carry cached
  `count_comment` / `count_like` / `count_replies` that the app increments/decrements on
  app-driven likes/comments AND reads (serializers + feed sort by `count_like`). Resync
  writes comments/likes directly (`createMany`/`upsert`), bypassing that increment, so the
  counters drift (0 / understated) for migrated + resynced content. Fix = a separate
  **recompute pass**: `pnpm resync:recount` (`apps/resync-worker/src/recount.ts`) — a
  set-based one-shot that rebuilds all five counters from actual rows, matching the app's
  exact semantics (`count_comment` = top-level comments, `count_replies` = replies,
  `is_deleted=false`). Idempotent + self-healing (~2.5s for 7.4k posts / 88k comments).
  Run it after a big posts sync and/or periodically (e.g. its own cron).

---

## 7. Dependency order (within a run)

```
members → enrollments
        → kyc
        → programs (affiliate programs of new BB courses)
        → tree (inviter + member-affiliators)
        → connect (P0-1 option C; after tree)
        → commissions   (needs recipient member + program)
        → reviews       (needs member)
        → posts→comments→replies→likes   (needs member; posts before comments before likes)
```
Members first so every downstream syncer can resolve `legacyId → uuid`. Within posts,
preserve post→comment→reply→like ordering.

---

## 8. Safety, observability, idempotency

- **Advisory lock** per run (anti-overlap).
- **Per-batch watermark commit** → resumable after `ECONNRESET`; re-run never duplicates
  (everything keyed on `legacyId` / composite uniques + upsert).
- **`--dry-run`** (no writes, report counts) and **`--since=ISO`** (manual watermark override).
- **pino** logging (no `console.log` in shipped code; the `scripts/` convention is console
  but the worker lives near app code — use the shared logger). Per-syncer stats persisted
  to `sync_state.lastStats`.
- **Explicit gap logging:** the `posts` syncer logs the one residual gap — legacy
  *un-likes* (hard deletes) do not propagate (§3). Everything else (edits, soft-deletes)
  rides the `updated` watermark.
- **First-run backlog:** initial watermark = migration timestamp; first run drains the
  delta-since-migration in batches. Confirm batch sizing handles the posts/comments backlog.

---

## 9. Open items before coding

1. ~~Verify legacy `updated` columns~~ — **DONE** (2026-06): every table has `updated`;
   all syncers are `incremental`. No reconcile sweep needed (only un-likes are a gap).
2. Confirm member **identity fields** (email/phone/`*Verified`) stay legacy-frozen for now
   (recommended — touching unique identity cols on a live account is risky).
3. Confirm soft-delete `updated`-bump assumption holds in practice for `comment.deleted` /
   `member.date_deleted` (Cresenity `save()` bumps `updated` — verify with one sample row).
4. One-off: import `scripts/member-redirect.json` → `member_redirect` table on deploy.
5. ~~New scoped members~~ — **DONE**: legacy still accepts registrations + brainboost
   purchases during cutover, so new members are created on demand via `ctx.ensureMember`
   (`scripts/resync/ensure-member.ts`) — same filters + dedup as `migrate-members`, scoped
   to brainboost because creation only fires when a brainboost-scoped row references the
   member. Wiring + no-regression validated on bb_trial (dry-run errors=0); a full create
   test needs a genuinely-new legacy member or a delete-and-recreate on a throwaway DB.

---

## 10. Batch audit fixes 07/08 (2026-10-06, P1/P2)

Implemented together with the P0 PRD; each has unit tests under `apps/resync-worker/tests/`.

- **`affiliateBased` provenance (`member.affiliate_based_source`).** The tree pass used to write
  `affiliateBased` unconditionally, reverting a PERFORMANCE/GROWTH switch the member made in the
  app (`AffiliatorService.setMode`, which now stamps source `APP`). Migration
  `20261008120000_member_affiliate_based_source` backfills legacy rows `LEGACY` / app rows `APP`;
  the tree writes only over NULL/`LEGACY` (`affiliate-mode-rules.ts`).
- **Adopt fill-if-null (`adopt-rules.ts`).** `ensureMember`'s adopt path no longer overwrites an
  app placeholder's profile/verification/activation: identity + profile fill only when empty,
  `isActive`/verified only ever raised, bank only when absent; a P2002 conflict drops that field
  from the write instead of nulling it.
- **Commission mode + update refresh (`commissions.ts`).** A NULL legacy `affiliate_based` at
  level ≥2 resolves to GROWTH (PERFORMANCE pays L1 only); the update branch now also refreshes
  `recipientId`/`level`/`affiliateBased`, so a forced re-scan or a redirect/split heals old rows
  (migrated rows have `paymentId = null`, so the unique key cannot collide).
- **Split hands borrowed KYC back (`identity.ts`).** After `resync:identity split`, a winner whose
  KYC came from the loser (no own legacy KYC, source `LEGACY`) is reset to `NONE` and its
  KYC-sourced bank cleared — a pair that are different people no longer keeps the other's KYC.
- **Enrollment revoked when the payment is no longer SUCCESS (`enrollments.ts`).** The scan now
  also rides `course_payment.updated` / `product_bundle_payment.updated` (legacy bumps only the
  payment on a refund/failed settlement). An active enrollment whose entitlement is gone is
  cancelled with reason `legacy_payment_revoked` (safely lifted again if legacy re-grants).
  Repair existing rows with a forced `pnpm resync enrollments --since=1970-01-01T00:00:00Z`.
- **Foreign phone preserved on legacy import (`normalizeLegacyPhonePair`).** Legacy numbers already
  in E.164 (`+27…`, `+852…`) were re-prefixed with `+62`, producing an undeliverable OTP target.
  The legacy importers (`ensureMember`, `identity split`, `migrate-members`, `migrate-from-legacy`)
  now split on the number's own dial code. **Existing 1 428 corrupted rows need a one-off repair**
  (audit `02-member-identity/telepon-luar-negeri-salah-normalisasi.csv`); the `+27 8xx` ones are
  flagged "mungkin nomor Indonesia" — decide by hand, do not guess.

---

## 11. Inviter correction + skip observability (2026-10-06)

- **Inviter correction tool (`pnpm repair:inviter`).** One-off, whitelisted repair of the
  redirect-collapse rows (`apps/resync-worker/src/repair-inviter.ts`, rules in
  `inviter-correction-rules.ts`): 424829 → 57, 409824 → NULL, 641123 → NULL (half of the mutual
  cycle 641626 ↔ 641123 — the tree guard refuses cycles, so it can never fix it), 390754 → 57
  (`--allowAppOwned` override — its inviter was set by the app to the "Juna (DEV)" test account).
  Dry-run by default (`--apply` to write); each row prints its legacy `member_network` parent
  chain, the current/proposed inviter, and runs the same 4-level cycle check; the write is gated
  on the values it read (optimistic `updateMany`, no-op if the row moved). After `--apply`, run a
  forced tree rescan so the corrected uplines propagate:
  `pnpm resync tree --dry-run --since=1970-01-01T00:00:00Z` then without `--dry-run`.
- **Skip observability (`stats.skipReasons` / `skipSamples`).** `Stats` gains a reason breakdown
  so the single `skipped` bucket (audit 07 #13: "mixes out-of-scope with data likely lost") is no
  longer opaque. `markSkip(stats, reason, pk?, count?)` counts a dropped row; `markReason(...)`
  counts a partial skip WITHOUT incrementing `skipped` — used where a row is still written
  (e.g. the tree upserts `affiliateBased`/code but cannot resolve the inviter parent, which the
  audit flagged as counted *both* skipped and upserted). Up to 5 example PKs are kept per reason,
  and `core.ts` logs `skip[reason=count …]` on the per-syncer line. Wired across members, tree,
  connect, enrollments, commissions, kyc, programs, reviews, posts and the new-member backfill.
- **`sync_issue` table + `ctx.recordIssue`.** Migration `20261008130000_sync_issue` adds the
  reconciliation list keyed `(syncer, legacy_pk, reason)` with `occurrences`/`first_seen_at`/
  `last_seen_at`/`resolved_at`. `ctx.recordIssue(reason, pk, detail)` upserts (never throws, no-op
  on a dry run) and is called ONLY for "needs attention" reasons — unresolved parent/member,
  guard-blocked, not-mapped course — never for the bulk out-of-scope traffic. A skipped row still
  advances the watermark, so this table is the only trace it leaves.

### TODO (not implemented): delta commission repair (PRD §8)

`pnpm repair:commission` only selects orders that have **no** commission row at all
(`NOT EXISTS` in `scanTargets`), then re-runs the engine. Two audit groups are already past
that filter because they DO have rows: the **7 misrouted** orders (paid to the parent instead
of the connect affiliator, ≈Rp 250 rb) and the **65 chain-cut** orders (L1 paid, upper levels
missing, ≈Rp 1,61 jt). The 248 "LOST" orders need no delta — once P0-1 gives them an
`inviter_id` they are picked up by the existing path.

Planned: a `--delta` mode that selects orders with `EXISTS`, recomputes the chain/rates with
the same helpers (`walkInviterChain` / `getPerformanceTier` / `computeAmount`), and reconciles
per `(recipientId, level)` — INSERT when the level is missing, UPDATE the existing row when it
is underpaid (the engine cannot: its `create` hits the `uniq_payment_recipient_level` unique and
the P2002 is swallowed), never claw back an overpayment (§1.2 — report only), `--backdate` for
the PENDING→BALANCE hold window. Must run **after** P0-1 + P0-4 are deployed and the tree has
been rescanned, or the delta is computed from the old (wrong) seed.

Open decisions before coding:
1. delta marker — `channel='adjustment'` (overloads `channel`, which means payment channel today,
   and there is a `[status, channel]` index used for finance reporting) **or** a dedicated column
   + migration?
2. an underpaid row already `BALANCE`/withdrawn — auto-update (double-pay risk) **or** insert the
   missing levels only and flag the row for manual review?
3. keep web/Xendit only (`provider IS NULL`), or also ingested orders (RevenueCat/Scalev/Lynk.id)
   that are gated by `affiliate_attribution_claims`?

Proposed default (pending confirmation): `channel='adjustment'`; insert-only plus auto-update for
`PENDING` rows; web/Xendit only.
