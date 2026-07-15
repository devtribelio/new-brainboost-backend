# Member Migration Plan (legacy → new)

> Status: **scripts implemented (§9), pending a fresh-DB run + commit (§9b).** Captures
> every consideration surfaced while scoping the legacy `member` migration. Supersedes the
> naive `migrateMembers` phase in `scripts/migrate-from-legacy.ts` (bulk `createMany
> skipDuplicates` + buggy `status=1` filter), which is unsafe for this data (see §3, §6).
> Row counts are from the staging legacy MariaDB (`tribelio_db`) as of 2026-06-17 and drift
> slightly as the live DB grows.

---

## 1. Why a dedicated script

The legacy `member` table has **~701k rows** with **no unique constraint on email or
phone**. The new `Member` model enforces `@unique` on **email**, **phone**, `legacyId`,
`code`, `username`, `googleSub`, `appleSub`, `affiliateCode`. Bulk `createMany
skipDuplicates` in Postgres = `ON CONFLICT DO NOTHING` **without a target**, so a row
that collides on **any** unique (incl. phone) is dropped **whole** — a member with a
fresh email but a duplicate phone loses their entire account (silent data loss). We need
deterministic winner-selection + junk filtering + enrollment/balance merge.

---

## 2. Scope — who do we migrate?

The new system is **brainboost-only** (58 published `course.client = 'brainboost'`
courses → 58 Products). The other ~657k members have no relevant data. Scope is the
**union** of two tiers.

**Tier 1 — members with brainboost data (must migrate):**

| Source | Members | Notes |
|---|---:|---|
| Enrolled in a brainboost course (`course_enrollment` ∩ brainboost) | 43,897 | the core set |
| + Brainboost commission recipients not already enrolled | +493 | earned but never bought |
| + Inviter/upline closure of the above (`member_network` tree) | +69 | needed for GROWTH multitier |
| **= Tier 1** | **≈ 44,461** | 6.3% of 701k |

**Tier 2 — network preservation (DECIDED: include — option A):**

| Source | Members | Notes |
|---|---:|---|
| Valid downlines of in-scope affiliators (referred via their code, not yet buyers) | +13,115 | all pass junk/identity filter (0 junk, 0 no-id) |
| **= Tier 1 + Tier 2** | **≈ 57,576** | final scope |

**Why Tier 2 is included (decided):** the new attribution engine
(`attribution.service.ts`) is **not** pure last-touch. Precedence is: (1) explicit
affiliate code on the purchase, (2) most-recent `AffiliateVisit` within the window
(default **365 days**, `app_settings: affiliate.cookieDays`), then **(3) fall back to the
buyer's permanent `inviterId`**. So preserving a downline's `inviterId` means a future
purchase with no fresh visit still credits their original brainboost affiliator. The
13,115 are all clean real accounts, so the cost is modest (+29%) for real retention value.

**Excluded:** 2,998 downlines whose inviter is **outside** scope (their `inviterId` would
dangle — the inviter isn't migrated), and the ~640k members with no brainboost link at all.

**Balance is OUT OF SCOPE (decided — see §8).** Balance-holders are not a scope criterion.

---

## 3. Data-quality findings (legacy member table)

### Junk (~237 rows, 0.03%) — exclude
- `email LIKE '%@example.com'` → 192 (RFC 2606 test domain).
- `name LIKE 'lxbfYeaa%'` → 227 (sqlmap/Acunetix scanner artifact, registered seconds apart = bot spam).
- No email **and** no phone **and** no social → 22 (unauthenticatable orphans; most have a password but no login handle).

### Generated emails — `@brainboost.id` (356 full DB / 61 in scope)
Random local-part, `is_email_verified = 0`, **100% have a phone**, ~91% phone-verified.
These users registered/verified by **phone**; the system generated a placeholder email.
**Rule:** migrate with `email = null`, phone is the identifier. (`@tribelio.com` ×11 are
real staff emails — keep.)

### Email rule (final)
```
if email LIKE '%@brainboost.id'  → email = null  (phone is identity)
elif email empty/null            → phone-only (or drop if no phone + no social)
else                             → keep email; isEmailVerified ← is_email_verified
```

### Member inclusion gate (do NOT filter `status = 1`)
The legacy `member` table has three flags; only **`is_deleted`** is a real soft-delete.
`status` is **not** an active/delete gate (2,587 rows are `status=0` yet `is_active=1`), so
the existing `migrate-from-legacy::migrateMembers` `WHERE status=1` filter is a **bug** that
drops live accounts (17 of them are in-scope brainboost buyers). Rule:

```
Within scope, the ONLY drops are: junk (§3) + no-identity + dedup-loser.
Never drop on status/is_deleted.
isActive = is_active AND NOT is_deleted   → deleted (18 in scope) or is_active=0 → isActive=false
```
i.e. deleted/inactive members still migrate, flagged `isActive = false` (decided: keep their
data — they paid).

---

## 4. Duplicate analysis

### Full table (no scope filter)
| Dup type | Groups | Rows involved | Extra (losers) |
|---|---:|---:|---:|
| Email (same email) | 586 | 1,617 | 1,031 |
| Phone (same phone) | 6,411 | 13,363 | 6,952 |
| Pair (email AND phone) | 121 | 306 | 185 |

"Extra" = `SUM(count − 1)` per group = rows beyond one winner. The huge email-dup groups
(max **191** copies of one `@example.com`) are bot junk. Largest phone group = 13.

### Within enrolled scope (43,897) — nearly clean
| Dup type | Groups | Extra |
|---|---:|---:|
| Email | 4 | 4 |
| Phone | 153 | 157 |

All 4 scoped email-dups are the **same person re-registering** (same name + phone; either
double-signup seconds apart, or re-register years later). Safe to merge.

---

## 5. Winner selection (per email / phone group)

Goal: keep the account the user **actually uses and can log into**, not just the oldest.
Apply in order, first decisive wins:

1. **`is_deleted = 0`** — never pick a soft-deleted account over a live one.
2. **has a brainboost enrollment** (Tier-1 buyer) — the account with real data/access.
3. **higher `login_count`** — the account they actually log into (100% populated; many 0).
4. **more recent `last_active`** — `NULL` loses (never active; ~87% populated).
5. `is_email_verified = 1` (email groups) / `is_phone_verified = 1` (phone groups).
6. has password OR social (authenticatable).
7. earliest `date_register` (stable fallback).
8. tie → smallest `member_id`.

**Why activity beats "earliest register":** for re-registrations (same person, new account
years later) the earliest row is often the *dead* account. Verified examples — Wilson
(`635642`: 8 logins + password + 5 courses, active 2026) beats his 2023 zero-login row;
Calvin's 2025 account beats his dormant 2021 one. Ranking by `login_count` / `last_active`
picks the live account; "earliest register" would wrongly pick the abandoned one.

Note: enrollments of the loser still **merge** to the winner (§6), so picking the active
account never loses purchased courses.

---

## 6. Dedup / merge rules

### Cluster with union-find (NOT two sequential passes)
Build connected components over the **full scope (~57.6k)**: connect two members if they
share an email OR a phone. Each component = one real person (may be >2 accounts). This
handles the transitive case (A=B by email, B=C by phone → one cluster). Measured on full
scope: **5 email-dup groups, 243 phone-dup extras; 6 members sit in both an email- and a
phone-dup group** (exactly the transitive case a naive two-pass would mishandle).

Per cluster: pick one **winner** (§5). Everyone else is a **loser**.

- **Winner** keeps `email` + `phone`.
- **Loser** → not inserted; their **enrollments merge to the winner**.
- **Phone-only collision, genuinely different people sharing a number** (different email, not
  same person) → both are separate clusters; both migrate; only one keeps the phone, the
  other gets `phone = null`. (Union-find connects by shared phone, so verify same-person via
  email/name before merging vs nulling — for the 14 generated-email `@brainboost.id` members
  whose phone collides, the phone is their only identity, so they must win the phone or be
  treated as the same person, never dropped to no-identity.)

### Inviter redirect (prevents dangling links)
Dropping losers breaks any `member_network` edge that points at a dropped `member_id`.
Build a **redirect map** `loser_legacyId → winner_legacyId` during clustering and persist it
(`scripts/member-redirect.json`). The tree backfill (§9 step 4) resolves a parent through
this map first, so a downline whose inviter was a dropped duplicate still links to the
surviving winner instead of going `null`.

### Enrollment merge
- **Dedup by `(memberId, courseId)`** (new `CourseEnrollment` is unique on it). Legacy
  `course_enrollment` has duplicate `(member, course)` rows (568 in scope; re-purchase) +
  losers' rows fold onto the winner → always collapse to one.
- **legacyId** = legacy `member_id` (always set; mobile app keys on it).

---

## 6b. Enrollment access rule — gate by PAYMENT, not `enrollment.status`

`course_enrollment.status` is **NOT** an access gate: 3,058 `status=0` rows are fully PAID
(`payment_status = SUCCESS`, avg ~Rp 287k). Filtering `status=1` would strip access from
~1,197 paying members. The real signal is the **payment**:

```
Migrate a BB enrollment when ANY:
  A) course_payment_id            → course_payment.payment_status = SUCCESS   (61,380 direct)
  B) product_bundle_payment_detail_id → product_bundle_payment.payment_status = SUCCESS (1,786 bundle)
  C) free / manual grant (payment_status NULL)
SKIP only payment_status = FAILED   (e.g. 1 member: checkout failed, stray enrollment row)
Ignore course_enrollment.status entirely.
Dedup by (memberId, courseId).
```

**`dateStart`**: legacy `course_enrollment.date_start` is **NULL for all** rows — use
`created` instead. Other carryable fields: `expiredDate`, `certificateCode`,
`certificateCreated`, `progress`, `legacyId` = `course_enrollment_id`.

---

## 7. Affiliate scope

Legacy is an MLM model — **every** member has an `affiliator_code` (699,859) and a
`member_network` tree node with `affiliate_based` (694,387), so those are **meaningless**
as an "affiliator" signal. Meaningful definitions:

| Definition | Members |
|---|---:|
| Joined an affiliate program (`member_product_affiliator`) | 20,291 |
| Actually earned commission (>0) | 3,004 |
| — earned **brainboost-only** | 1,235 |
| — earned **non-brainboost only** | 1,419 |
| — earned **mixed** (BB + non-BB) | 350 |
| Has an inviter / used another's code (`member_network.parent_id`) | 19,400 |
| Has balance > 0 | 3,820 |

Brainboost-relevant affiliators = BB-only + mixed = **1,585**. Of those, 493 are not
enrolled (added to scope) + 69 upline-closure.

"Join program" = a member registers as an affiliator for a specific product (gets an
affiliate link); ~17k joined but never earned.

### AffiliateProgram link — FIXED (separate from member migration)
`migrateAffiliatePrograms` only set `productId` when legacy `productable` contained
"product", so every **course** program (`productable = 'TBModel_Course'`) migrated with
`productId = NULL` + `isActive = false`. Result: 56/58 brainboost products had no usable
program → `commitCommissionsForPayment` early-returns "no programId". Fixed by
**`scripts/backfill-affiliate-program-product.ts`** (`pnpm backfill:affiliate-program-product`):
links each course `AffiliateProgram` (`legacyId = napa_id`) to its `Product`
(`legacyId = course_id`) and sets `isActive = true`. Ran on staging → **58/58 brainboost
products now have an active program.** Still open (NOT this migration): the visit→program
resolution (app OneLink sends product + affCode, no programCode) and the
`commitCommissionsForPayment` `programId`-required-vs-optional inconsistency.

### MemberAffiliator — migrate as a SEPARATE step after member+enrollment
`MemberAffiliator` = a member's membership in an affiliate program (who joined which
program). Legacy `member_product_affiliator` → resolve member via `network_account_affiliator`
+ program via `network_account_product_affiliator_id`. Brainboost: 17,520 join-rows / **6,840
distinct members**. NOT required for commissions (`affiliatorId` is nullable on
`AffiliateCommission`) but needed for the "my affiliate programs" listing + a populated
`affiliatorId`. Decided: **migrate**, as `scripts/migrate-member-affiliators.ts`, scoped to
already-migrated members + existing programs, keyed `legacyId = member_product_affiliator_id`,
unique `(memberId, programId)`.

---

## 8. Balance — DECIDED: OUT OF SCOPE (ignored)

> **Decision:** balance / withdrawals are **not migrated**. The new system starts with no
> carried-over affiliate balance. Legacy balances are settled/handled separately in the
> legacy system. The analysis below is retained as the rationale for why dropping balance
> is low-risk, and as a reference if the decision is ever revisited.

**Why this is safe (the short version):** the headline Rp 15.2 B is misleading — **83% is
two internal/company accounts** (member 57 = Denny Santoso, the owner, Rp 10.76 B of
course-sales *revenue* not affiliate liability; member 400713 = "Tribelio X Dean", Rp 1.86 B).
The **entire top 10 holders (92% of all balance) have zero brainboost affiliate payout** —
they are company accounts or non-brainboost funnel sellers. Real member brainboost-affiliate
balance is tiny: the 263 non-company "mixed" affiliators hold only **Rp 76 M** total, and
all-time brainboost affiliate commission is ~**Rp 502 M**. So ignoring balance drops almost
no genuine member-owed money.

### The problem (reference)
`member_balance.balance` is a **single aggregate** per member (4,712 members, total
**Rp 15.2 B**). It is **not** the sum of the sparse per-vertical tables
(`member_balance_product` has only 7 rows, etc.). Withdrawals (`member_withdraw`,
`disbursement_withdraw`) debit the aggregate **untagged by product**. So a "mixed"
affiliator's balance is brainboost + non-brainboost commingled.

| Bucket | Members | Balance |
|---|---:|---:|
| Balance > 0 total | 3,820 | Rp 15.2 B |
| In-scope (brainboost earners) | ~1,670 | — |
| — of which **mixed** with balance | 265 | **Rp 12.7 B** (84% of all balance!) |
| Out-of-scope (pure non-brainboost) | 2,150 | Rp 2.3 B |
| Pending withdrawals (`member_withdraw` PENDING) | — | 976 rows |

### The breakthrough — `member_balance_history` is a source-tagged ledger
437k rows, 4,712 members. Each entry has `balance_before / balance_in / balance_out /
balance_after` (running balance) + **`module`** (e.g. `TBModel_CoursePayment`,
`TBModel_CanvasCheckoutPayment`, `TBModel_AffiliatorCommision`) + **`ref_table` / `ref_id`**
(e.g. `course_payment`, `affiliator_commision`, `member_withdraw`). This makes
brainboost-attributable balance **reconstructible**:

```
BB_credit[member] = SUM(member_balance_history.balance_in)
   WHERE ref_table = 'affiliator_commision'
     AND ref_id → affiliator_commision row whose product is a brainboost course
   (+ any direct brainboost course-seller credits, if applicable)
```
Withdrawal allocation (fungible debits) remains a **policy choice** (proportional or FIFO
over the chronological ledger) — but it is now *computable*, not impossible.

### Why this de-risks the decision
- Total **brainboost affiliate payout ever** (`SUM(price_recipient)`, all-time) ≈
  **Rp 502 M** — small vs the Rp 15.2 B system total. (Note: `commision_amount` is the
  **rate %**, not rupiah; the rupiah field is `price_recipient`.)
- So the Rp 12.7 B "mixed" balance is overwhelmingly **non-brainboost**. Brainboost-only
  reconstructed liability is **≤ ~Rp 502 M**.
- **Caveat:** the `affiliator_commision.is_balance` flag is **unused** (0 rows set across
  the whole table) — do NOT trust it for "settled". The ledger is the source of truth.

### Resolved
Balance is **out of scope** (§8 header). The reconstruction method, ledger source-of-truth,
and the per-bucket numbers above are kept only as the audit trail behind that decision and a
recipe should it ever be revisited. No balance, withdrawal, or company-account special-casing
runs in the member migration.

---

## 9. Scripts & run order (IMPLEMENTED)

All three scripts are written + typecheck-clean; dry-runs on staging legacy + the dev DB
are sensible (numbers below). Not yet committed; not yet run end-to-end (the target DB is
dropped + rebuilt fresh, so no clean-slate step is needed — `createMany skipDuplicates`
keyed on `legacyId` has nothing to collide with on a fresh DB).

**Tables written:** only `members` (insert + tree update) and `course_enrollment` (insert).
Everything else (legacy member/enrollment/payment/commission/network) is read-only source.
Balance/withdraw, programs, commissions are NOT touched here.

### `migrate-members.ts` — `pnpm migrate:members` (member + enrollment, one pass)
Dry-run: scope **57,689** (T1+T2), dedup → **57,423 winners / 266 losers**, enrollments
**62,520** (716 dup-pairs collapsed, 1 FAILED-payment skipped).
1. Build **scope** legacy `member_id`: Tier 1 = enrolled ∪ BB recipients ∪ upline-closure;
   Tier 2 = valid downlines of in-scope affiliators (option A). ≈ 57,576. No balance criterion.
2. **Junk filter** (§3) + **no-identity** drop. **Email rule** (§3) — null `@brainboost.id`.
3. **Cluster + dedup** via union-find over email∨phone (§6); pick winner (§5); record
   `loser→winner` redirect → `scripts/member-redirect.json`.
4. **Insert Member**: `legacyId`, canonical phone, social sentinel password,
   `isActive = is_active AND NOT is_deleted` (§3 gate — NOT `status=1`), verified flags follow
   surviving contact.
5. **Migrate enrollments** in the same pass: access = payment SUCCESS (course OR bundle) or
   free (§6b); `dateStart = created`; dedup `(memberId, courseId)`; losers' enrollments fold
   onto winner.

### `backfill-affiliate-tree.ts` — `pnpm tsx scripts/backfill-affiliate-tree.ts` (extended)
6. Sets `inviterId / affiliateBased / affiliateCode` from `member_network`. Now **reads
   `member-redirect.json`** so a parent that was a dropped duplicate resolves to the winner
   (fixes the dangling-inviter gap §6).

### `migrate-member-affiliators.ts` — `pnpm migrate:member-affiliators` (after the above)
7. `member_product_affiliator` → `MemberAffiliator(memberId, programId)`, scoped to migrated
   members + linked (brainboost) programs, redirect-aware, keyed
   `legacyId = member_product_affiliator_id`, unique `(memberId, programId)` (§7). Dry-run on
   a not-yet-migrated DB is limited (members absent); real numbers appear after step 5.

### Full sequence (on a fresh DB)
```
migrate:products → course-sections → course-lessons
→ backfill:affiliate-program-product        (58/58 programs linked + active)
→ migrate:members                           (members + enrollments + writes redirect.json)
→ backfill-affiliate-tree                    (reads redirect.json)
→ migrate:member-affiliators
```
Balance: not done (out of scope, §8).

---

## 9b. Still open / not done
- **Commit** the three scripts + this doc.
- **Real end-to-end run** on the fresh target DB — the only thing the dry-runs cannot fully
  prove: `migrate-members` enrollment insert (dry-run used placeholder member UUIDs) and the
  `migrate-member-affiliators` counts (members absent until step 5).
- **Affiliate, separate from member migration** (blocks commissions, not members):
  - visit→program resolution — the app OneLink sends `product + affCode` with no programCode,
    so the visit/checkout must derive the (1-per-product) program from the product;
  - the `commitCommissionsForPayment` `programId`-required vs the visit-layer "program is
    optional metadata" inconsistency — a design decision (use-program vs program-optional).
- **Optional / undecided:** disposable-email filter for Tier 2 (e.g. yopmail/mailinator —
  count not yet measured); whether `MemberAffiliator` should cover non-brainboost programs
  (currently brainboost-linked only).
- Implementation-time edges already coded for: generated-email `@brainboost.id` → email=null
  so phone is the key; union-find absorbs phone-normalization collisions.

---

## 10. Key legacy schema notes
- `member`: cols incl. `email, phone, password, is_email_verified, is_phone_verified,
  google_id, sign_in_with_apple_id, affiliator_code, date_register`, activity signals
  `last_active` (datetime, ~87% filled) + `login_count` (bigint, 100% filled). Three
  separate flags: **`is_deleted`** (the real soft-delete, 2,206 rows), `is_active`
  (account enabled), and `status` — **`status` is NOT a delete/active gate** (2,587 rows
  are `status=0` yet `is_active=1`); the existing `migrateMembers` `WHERE status=1` filter
  is a bug that drops live accounts. No `username`, no `last_login`, no direct inviter column.
- `course.client = 'brainboost'` is the catalog filter (58 published).
- `course_enrollment`: `member_id, course_id, course_payment_id,
  product_bundle_payment_detail_id, date_start, is_canceled, status, expired_date,
  certificate_code, …`. 196k rows total, 63k on brainboost. **`date_start` is NULL for all**
  (use `created`). **`status` is not an access gate** (3,058 `status=0` are PAID). Access =
  `course_payment.payment_status='SUCCESS'` OR (via `product_bundle_payment_detail` →
  `product_bundle_payment.payment_status='SUCCESS'`, 1,786 bundle) OR free; skip FAILED.
- `network_account_product_affiliator` (affiliate programs) ↔ new `AffiliateProgram`
  (`legacyId = napa_id`); `productable='TBModel_Course'`, `productable_id = course_id`. All 58
  brainboost programs are `is_active=0` in legacy. `member_product_affiliator` (joins) resolves
  to a member via `network_account_affiliator.member_id`.
- `member_network`: one node per member; `parent_id` → parent **node** (resolve node →
  member_id for inviter); `affiliate_based` ∈ {GROWTH, PERFORMANCE, INACTIVE}.
- `affiliator_commision`: `member_recipient_id` (earner), `member_downline_id` (buyer),
  `product_model` / `product_id` (source), `commision_amount` (**rate %**),
  `price_recipient` (**rupiah**), `is_pending/is_expired/is_balance` (**is_balance unused**).
- `member_balance` (aggregate) + `member_balance_history` (source-tagged ledger, the real
  truth). Withdrawals: `member_withdraw`, `member_withdraw_automatic`, `disbursement_withdraw`.
- Legacy `product` table = abandoned physical-goods marketplace (junk) — **not** a source.
