# Backoffice Port Plan

Port the legacy Tribelio admin-backoffice surface (`tribelio-admin/` controllers + `/api/oracle/*` methods) into a **new JSON-only module** in `bb-backend-new`. Frontend is a separate SPA — backend exposes REST/JSON only.

> Distinct from `src/modules/admin/` (the EJS internal sysadmin scaffold). That one stays for fast DB-level CRUD; backoffice is the product-facing ops surface consumed by an external client app.

---

## 1. Naming & layout

- **Module name:** `backoffice`
- **Route prefix:** `/api/backoffice/*`
- **Response shape:** standard envelope from `src/common/utils/response.util.ts` (`ok` / `okPaginated` / `fail`).
- **No views.** All `*.controller.ts` are JSON-only. No EJS, no flash, no cookies for auth.

Folder layout:

```
src/modules/backoffice/
  backoffice.module.ts                       # AppModule export
  backoffice.routes.ts                       # bindRoute(...) entries
  backoffice.types.ts                        # BackofficeRequest, BackofficePrincipal
  auth/
    backoffice-auth.controller.ts            # POST /login, POST /refresh, POST /logout
    backoffice-2fa.controller.ts             # POST /2fa/setup, /2fa/verify, /2fa/disable
    backoffice-auth.service.ts
    backoffice-auth.middleware.ts            # bearer JWT + RBAC
    dto/
  dashboard/
    dashboard.controller.ts                  # exec summary, DAU, growth, revenue, top tribes/posts
    dashboard.service.ts
  member-ops/
    member-ops.controller.ts                 # list, detail, impersonate, force-verify, force-reset
    member-ops.service.ts
  sales/
    sales.controller.ts                      # bundle + course sales, affiliate-split modal
    sales.service.ts
  refund/
    refund.controller.ts                     # list, approve, reject, upload-proof
    refund.service.ts
  withdraw/
    withdraw.controller.ts                   # list, approve, reject, execute
    withdraw.service.ts
  balance-adjust/
    balance-adjust.controller.ts             # manual credit/debit w/ audit
  affiliate-admin/
    affiliate-admin.controller.ts            # brainboost list/delete, commission tree, payout history, export
    affiliate-admin.service.ts
  moderation/
    course-moderation.controller.ts          # powerup approve/reject, super-affiliate toggle
    content-moderation.controller.ts         # post/comment curation, report queue resolve
  voucher-admin/
    voucher-admin.controller.ts              # CRUD, export, blacklist
  bank/
    bank.controller.ts                       # bank account CRUD for disbursement routing
  insight/
    insight.controller.ts                    # tribe insight (revenue rollup), member device split
  search/
    search.controller.ts                     # cross-entity (member, post, comment, network)
  integration/
    integration.controller.ts                # WhatsApp pairing, Notifi quota, Bunny, Xendit keys
  feedback-triage/
    feedback-triage.controller.ts            # bug + mobile-feedback queues
  log/
    log.controller.ts                        # push notification delivery log viewer
```

Register in `src/core/register-modules.ts` alongside existing modules. **Do not** touch `src/modules/admin/`.

---

## 2. Auth model

**Reuse `Admin` Prisma model + `signAdminToken`/`verifyAdminToken`** from `src/modules/admin/admin.jwt.util.ts`. Diffs vs current admin auth:

| Concern | Current EJS admin | Backoffice JSON |
|---|---|---|
| Token transport | `httpOnly` cookie (`bb_admin`) | `Authorization: Bearer <jwt>` header |
| Failure mode | redirect `/admin/login` | `401 UNAUTHORIZED` JSON |
| 2FA | none | required for SUPERADMIN/FINANCE; optional for others |
| Refresh token | none (8h JWT) | yes — short access (15m) + refresh (7d) like member auth |
| RBAC | `requireRole('SUPERADMIN','ADMIN')` only | `requireRole(...)` extended to 4 roles |

Schema changes (additive — keep current admin functional):

```prisma
enum AdminRole {
  SUPERADMIN
  ADMIN
  SUPPORT      // NEW — read-only + impersonate
  FINANCE      // NEW — refund / withdraw / balance-adjust / commission ops
}

model Admin2FA {
  adminId        String   @id @db.Uuid
  secret         String                                 // base32 TOTP secret (encrypted at rest)
  recoveryCodes  String[] @default([])
  enabledAt      DateTime?
  lastVerifiedAt DateTime?
  admin          Admin    @relation(fields: [adminId], references: [id], onDelete: Cascade)
  @@map("admin_2fa")
}

model AdminRefreshToken {
  id        String   @id @default(uuid(7)) @db.Uuid
  adminId   String   @db.Uuid
  tokenHash String   @unique @map("token_hash")
  expiresAt DateTime @map("expires_at")
  revokedAt DateTime? @map("revoked_at")
  createdAt DateTime @default(now()) @map("created_at")
  admin     Admin    @relation(fields: [adminId], references: [id], onDelete: Cascade)
  @@index([adminId])
  @@map("admin_refresh_tokens")
}

model AdminAuditLog {
  id         String   @id @default(uuid(7)) @db.Uuid
  adminId    String   @db.Uuid
  action     String                                      // e.g. "member.impersonate"
  targetType String   @map("target_type")                // e.g. "Member"
  targetId   String?  @map("target_id")
  metadata   Json?                                       // arbitrary action params
  ip         String?
  userAgent  String?  @map("user_agent")
  createdAt  DateTime @default(now()) @map("created_at")
  admin      Admin    @relation(fields: [adminId], references: [id], onDelete: Cascade)
  @@index([adminId, createdAt])
  @@index([targetType, targetId])
  @@map("admin_audit_logs")
}
```

Every high-risk action (impersonate, balance adjust, refund approve, withdraw approve, voucher delete) writes one `AdminAuditLog` row.

---

## 3. Single-tenant simplification

Every legacy query is `org_id`-scoped. **Drop entirely** — bb-backend-new is single-tenant per `[[project_rewrite_context]]`. Pattern when porting:

```php
// legacy
->where('network.org_id', $orgId)
```
```ts
// new — just delete the where clause
```

---

## 4. Sprint sequence

| Sprint | Module(s) | Deliverable |
|---|---|---|
| 1 | `backoffice/auth` + schema migrations | Login (bearer), refresh, 2FA setup/verify, audit log, RBAC middleware, expand `AdminRole` enum. Smoke test. |
| 2 | `backoffice/bank` + `backoffice/withdraw` + `AffiliateDisbursement` extension | Bank CRUD, payout approve/reject/execute, integrates `affiliate.disbursement.service`. |
| 3 | `backoffice/refund` + `backoffice/balance-adjust` + `backoffice/sales` + `CommerceRefund` table | Refund lifecycle, manual balance audit, sales analytics endpoints. |
| 4 | `backoffice/affiliate-admin` + `backoffice/moderation` + `PowerupRequest` table | Brainboost ops, commission tree + PDF/CSV export, course moderation, post curation. |
| 5 | `backoffice/dashboard` + `backoffice/insight` + `backoffice/search` | 6 tiles: DAU, exec summary, growth, platform split, revenue, trending. Cross-entity search + device insight. |
| 6 | `backoffice/voucher-admin` + `backoffice/integration` + `backoffice/feedback-triage` + `backoffice/log` | Voucher mgmt + blacklist, integration config, bug/mobile feedback, push delivery log viewer. |

---

## 5. Endpoint scope summary

| Cluster | Endpoints inventoried | P0 | P1 | P2 | SKIP |
|---|---|---|---|---|---|
| [A — Member/Auth/Network/Log/Sysadmin](backoffice-port/cluster-a-member-auth.md) | 107 | 8 | 24 | — | 75 |
| [B — Course/Content/CMS](backoffice-port/cluster-b-course-content.md) | 60 | 9 | 14 | 2 | 35 |
| [C — Finance/Voucher/Disbursement](backoffice-port/cluster-c-finance.md) | 34 | 5 | 14 | 2 | 13 |
| [D — Affiliate/Bot/Campaign](backoffice-port/cluster-d-affiliate.md) | 26 | 7 | 4 | — | 15 |
| [E — Dashboard/Insight/Integration/Cron](backoffice-port/cluster-e-dashboard-insight.md) | 56 | 6 | 38 | 1 | 11 |
| [F — Oracle API methods (`/api/oracle/*`)](backoffice-port/cluster-f-oracle-methods.md) | 8 | 2 | 2 | — | 4 |
| **TOTAL** | **291** | **37** | **96** | **5** | **153** |

~53% drop (multi-tenant orgs, page-builder, blog/CMS, FB/TikTok pixel, email-blast bots, smartlist CRM, MongoDB monitors).

---

## 6. Gaps vs existing `src/modules/admin/` (EJS)

EJS admin currently covers basic CRUD on 26 entities (Member, Banner, Product, Course, Topic, Post, Comment, Network, Notification, etc). It is **not** removed — it stays as the operator's "raw DB editor".

Backoffice adds **product ops** on top:

- Admin hardening (2FA, refresh, audit log, 4-role RBAC, bearer header)
- Member ops actions (impersonate, force-verify, force-reset, bulk select)
- Sales views (bundle + course + affiliate-split modal)
- Refund + withdraw approval flow
- Manual balance adjust w/ audit
- Affiliate ops (brainboost, commission tree, payout, export PDF/CSV)
- Disbursement core (bank CRUD, request, approve, execute)
- Dashboard tiles (DAU, exec, growth, platform split, revenue, trending)
- Cross-entity search + device insight
- Course moderation (powerup, super-affiliate)
- Voucher admin (CRUD, export, blacklist)
- Integration config (WhatsApp, Notifi, Bunny, Xendit)
- Bug/feedback triage
- Push notification delivery log

---

## 7. Integration risks (carry-over from analysis)

1. **Refund flow vs commerce webhook.** Legacy `TBRefund` does manual "mark PAID", bypassing Xendit. New flow must use explicit reversal job + reverse `CourseEnrollment` + emit `DisbursementCreated`. Do **not** replicate the legacy hack.
2. **Manual balance adjust vs commission ledger race.** `affiliate.disbursement.service` computes balance dynamically. Manual adjust = atomic SQL + journal row, not async sync.
3. **Single-tenant migration.** Every Oracle method + most legacy admin queries scope by `org_id`. Drop entirely.
4. **Oracle dispatcher pattern (`TBApi_Oracle_Method_*`).** Don't port. Flat REST routes only.
5. **Datatable AJAX.** Reuse standard `?page=&perPage=&search=` from `okPaginated`. Don't replicate per-table reload endpoints.
6. **Bunny secrets / Xendit keys.** Keep in `env.ts` (`required()`), not DB. Integration admin only shows status, doesn't store secrets.

---

## 8. New Prisma tables needed across all sprints

- `Admin2FA`, `AdminRefreshToken`, `AdminAuditLog` (sprint 1)
- `BankAccount`, `AffiliateDisbursement` extension (sprint 2)
- `CommerceRefund`, `BalanceAdjustment` (sprint 3)
- `PowerupRequest`, `AffiliateConnectionRemovalLog` (sprint 4)
- `VoucherBlacklist` (sprint 6)
- `IntegrationStatus` (optional sprint 6 — provider health snapshot)

---

## 9. Out of scope (do not port)

- Tribelio creator-studio (canvas, page-builder, blog/CMS, landing pages)
- Email blast / auto-responder / smartlist CRM
- Telegram/WhatsApp reminder bots (`bot/*`)
- FB/TikTok pixel integration
- `tribeliopage/`, `shortlink/`, `cresenity/` apps
- MongoDB-backed quota monitors
- Per-org / multi-tenant scoping
- Web shop / event tribe-level orders
- Lynk.id third-party integration
