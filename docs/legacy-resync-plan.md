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

> **Code lives in the SEPARATE repo `bb-legacy-resync`** (sibling dir), not here — it's a
> throwaway transition tool, retired after cutover. This repo stays the **schema owner**:
> the `sync_state`/`member_redirect` tables + `members.legacy_synced_at` column (migration
> `20260624120000_add_resync_tables`) live here; `bb-legacy-resync` copies `schema.prisma`
> + `phone.util` to generate its client and never migrates. This doc (design + business
> rules) stays here as the spec. Paths below like `scripts/resync/*` now map to
> `bb-legacy-resync/src/*`.

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
- **First-run is slow** (tree ~6.6min, posts ~6.5min, members ~5min): a full legacy scan
  since epoch + per-row sequential writes (members raw UPDATE, tree member.update). Steady
  hourly runs are tiny. Optional optimization: batch the members/tree writes with
  concurrency (like backfill-affiliate-tree's CONCURRENCY=25) to cut first-run ~3-4×.
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
- Add `legacySyncedAt`. On each run, for a candidate member:
  - if `member.updatedAt <= legacySyncedAt` (no app-side write since last sync) →
    **overwrite** the legacy-owned fields, then set `legacySyncedAt` = the same write
    timestamp (raw upsert sets `updated_at = now()` and `legacy_synced_at = now()` in one
    statement so they stay equal → next run sees "untouched" unless the app writes).
  - if `member.updatedAt > legacySyncedAt` (user changed something in the new app) →
    **skip** the legacy-owned fields (new wins). Still allowed: `isActive=false` from
    `is_deleted=1` (deactivation always propagates).
  - first ever sync (`legacySyncedAt IS NULL`) → treat as legacy-owned (overwrite).
- **Legacy-owned fields** (subject to overwrite when untouched): `fullName`, `avatarUrl`,
  `bio`, `gender`, `birthdate`, `isActive` (from `is_active && !is_deleted`).
- **Never legacy-owned** (app or other syncers own these): `passwordHash`/`passwordAlgo`,
  `email`/`phone`/`*Verified` (identity — touching unique cols on a live account is risky;
  leave to a deliberate later pass), all `kyc*`, all `bank*`, `affiliateCode`/`code`,
  `inviterId`/`affiliateBased` (owned by the **tree** syncer).
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

### enrollments — incremental, low risk
- Key `legacyId`; also dedupe on `@@unique([memberId, courseId])`. Upsert. Access rule
  identical to migration (payment SUCCESS or free). Re-point `member_id` through
  `member_redirect`. Skip if course not in the migrated 58 or member out of scope.
- No new-system conflict (new purchases create their own enrollments with `legacyId=null`).

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
- Only set `inviterId` if currently null OR the member is still legacy-owned (untouched),
  to avoid fighting any new-app referral.

### reviews — incremental
- `product_review` `WHERE COALESCE(updated,created) > :watermark`, key `legacyId`, upsert.
  Needs product + member to exist (skip otherwise).

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

---

## 7. Dependency order (within a run)

```
members → enrollments
        → kyc
        → tree (inviter + member-affiliators)
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
```
