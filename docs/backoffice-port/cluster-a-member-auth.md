# Backoffice Port — Cluster A: Member / Auth / Network / Log / Sysadmin / Feedback

Legacy scope: `tribelio-platform/cresenity-app/application/tribelio-admin/default/controllers/` — `account.php`, `auth*`, `authentication.php`, `forgotPassword.php`, `home.php`, `member*`, `network.php`, `tribe/**`, `search.php`, `log/**`, `userdatatracking/**`, `sysadmin/**`, `feedback/**`, `data/**`, `seo.php`, `lang.php`, `multilang.php`, `languageBackend.php`, `interest.php`, `reloadBa.php`.

**Totals:** 107 endpoints — **P0: 8 · P1: 24 · SKIP: 75**

---

## Inventory

| Legacy URL | Controller:action | Purpose | Lib | New entity | Mobile-admin? | Priority | Notes |
|---|---|---|---|---|---|---|---|
| /account/changePassword | account:changePassword | Admin password change form | TBModel_Users | — | NO | P2 | Move under `/api/backoffice/auth/change-password`. |
| /auth/check | auth:check | Dev-only login check (md5) | TBModel_Users | — | NO | SKIP | Unsafe, dev-only. |
| /auth/login | auth:login | Legacy login (returns 404) | TBModel_Users | — | NO | SKIP | Disabled in legacy. |
| /auth/google/callback | auth:google:callback | OAuth2 Google callback | TBModel_Users meta | — | YES | P1 | Optional SSO for admin team. |
| /auth/google/disconnect | auth:google:disconnect | Revoke Google OAuth | TBModel_Users meta | — | NO | SKIP | Defer. |
| /authentication/index | authentication:index | 2FA setup (Google Authenticator) | TBModel_Users | Admin2FA | YES | **P0** | `POST /api/backoffice/auth/2fa/setup`. |
| /authentication/verification | authentication:verification | Verify 2FA code | TBModel_Users | Admin2FA | YES | **P0** | `POST /api/backoffice/auth/2fa/verify`. |
| /authentication/reverify | authentication:reverify | Re-verify 2FA | TBModel_Users | Admin2FA | YES | P1 | `POST /api/backoffice/auth/2fa/reverify`. |
| /authentication/disable | authentication:disable | Disable 2FA | TBModel_Users | Admin2FA | YES | P1 | `POST /api/backoffice/auth/2fa/disable`. |
| /forgotPassword/requestOtp | forgotPassword:requestOtp | Request OTP for admin reset | TBGenerateCode | OtpCode | YES | P1 | `POST /api/backoffice/auth/forgot/request`. |
| /forgotPassword/reset | forgotPassword:reset | Reset password via OTP | TBGenerateCode | OtpCode | YES | P1 | `POST /api/backoffice/auth/forgot/reset`. |
| /forgotPassword/verify | forgotPassword:verify | Verify OTP token | TBGenerateCode | OtpCode | YES | P1 | `POST /api/backoffice/auth/forgot/verify`. |
| /home/index | home:index | Dashboard landing | invoke executiveSummary | — | YES | **P0** | Replaced by `/api/backoffice/dashboard/summary`. See cluster E. |
| /member/index | member:index | Member list (filtered, datatable) | TBMember, TBAdmin | Member | YES | **P0** | `GET /api/backoffice/members?status=&q=&page=`. EJS admin already has CRUD; backoffice adds filtered list w/ status. |
| /member/reloadTableMember | member:reloadTableMember | AJAX reload | TBMember | Member | YES | P1 | Same endpoint as above, drop AJAX-specific route. |
| /search/index | search:index | Global search (cross-entity) | TBOracle::api('Search') | Member, Post, Comment, Network | YES | P1 | `GET /api/backoffice/search?q=&type=`. See Oracle Search method in cluster F. |
| /search/reload | search:reload | AJAX search reload | TBAdmin::api('Search') | same | YES | P1 | Same endpoint w/ pagination. |
| /lang/change | lang:change | Admin UI language switch | TBLang | — | NO | SKIP | FE responsibility now. |
| /seo/robots | seo:robots | robots.txt | — | — | NO | SKIP | Static file. |
| /multilang/index | multilang:index | i18n editor tabs | TBLang | — | NO | SKIP | Out of scope. |
| /multilang/lang | multilang:lang | Load lang file | TBLang | — | NO | SKIP | Out of scope. |
| /multilang/form | multilang:form | Edit lang strings | TBLang | — | NO | SKIP | Out of scope. |
| /languageBackend/* | languageBackend:* | Backend i18n editor | TBLang | — | NO | SKIP | Out of scope. |
| /interest/index | interest:index | Interest/category list | TBModel_Interest | — | NO | P2 | If we add interests later, basic CRUD. |
| /interest/add /edit /delete /getData | interest:* | Interest CRUD + datatable | TBModel_Interest | — | NO | P2 | Defer. |
| /network/index | network:index | Tribe list (filtered) | TBModel_Network | Network | YES | **P0** | `GET /api/backoffice/networks?q=`. EJS already has CRUD. |
| /network/reloadTableNetwork | network:reloadTableNetwork | AJAX reload tribe table | TBModel_Network | Network | YES | P1 | Same as above. |
| /network/add /edit /delete | network:add/edit/delete | Tribe write | TBModel_Network | Network | YES | P1 | Reuse new `network.service` CRUD. |
| /network/getData | network:getData | Datatable rows | TBModel_Network | Network | YES | **P0** | Same as /network/index. |
| /network/modalListMemberJoin | network:modalListMemberJoin | Tribe member list | TBModel_NetworkMember | NetworkMember | YES | P1 | `GET /api/backoffice/networks/{id}/members`. |
| /tribe/tribe/index | tribe:tribe:index | Tribe summary datatable (likes/posts/members) | TBModel_Network subqueries | Network | YES | **P0** | `GET /api/backoffice/insight/tribes` — rollup stats. Belongs to insight controller (cluster E). |
| /tribe/account/index | tribe:account:index | Tribe BA settings | TBModel_Network + TBModel_Account | — | NO | SKIP | Multi-tenant BA flow; not in scope. |
| /tribe/babyTribe/index | tribe:babyTribe:index | Sub-tribe list | TBModel_Network | — | NO | SKIP | Not in mobile data model. |
| /tribe/pixel/* | tribe:pixel:* | Pixel tracking | TBModel_Pixel | — | NO | SKIP | Web-only. |
| /tribe/pixelshop/* | tribe:pixelshop:* | Shop pixel | TBModel_Pixel | — | NO | SKIP | Web-only. |
| /tribe/pixelMultiLink/* | tribe:pixelMultiLink:* | Multi-link pixel | TBModel_Pixel | — | NO | SKIP | Web-only. |
| /log/pushnotif/index | log:pushnotif:index | Push notification logs datatable | TBModel_NotificationPushnotifQueue | Notification + new `PushDeliveryLog`? | YES | P1 | `GET /api/backoffice/logs/push?status=`. See cluster E integration. |
| /log/email/* | log:email:* | Email log | TBModel_EmailQueue | — | NO | SKIP | Mobile uses FCM, not email blast. |
| /log/export/* | log:export:* | Data export audit | TBModel_ExportData | — | NO | SKIP | Defer. |
| /log/lastActive/index | log:lastActive:index | Member last-active datatable | TBMember login | Member.lastSignInAt | YES | P2 | `GET /api/backoffice/members?sort=lastSignInAt`. |
| /log/suspect/* | log:suspect:* | Fraud suspect | TBModel_SuspectLog | — | NO | SKIP | Defer. |
| /log/paymentSuspect/* | log:paymentSuspect:* | Payment fraud | TBModel_PaymentSuspect | — | NO | SKIP | Defer. |
| /feedback/reportbug/index | feedback:reportbug:index | Bug reports datatable | TBModel_ReportBug | new `BugReport`? | YES | P1 | `GET /api/backoffice/feedback/bugs`. Needs new schema. |
| /feedback/bugs/index | feedback:bugs:index | Bug triage UI | TBModel_ReportBug | new | YES | P1 | Same datasource — status field. |
| /feedback/reportUser/index | feedback:reportUser:index | User abuse reports | TBModel_MemberReport | MemberReport | YES | P1 | `GET /api/backoffice/moderation/member-reports?status=PENDING`. |
| /feedback/reportTribe/index | feedback:reportTribe:index | Tribe abuse reports | TBModel_PostReport | PostReport | YES | P2 | `GET /api/backoffice/moderation/post-reports`. |
| /feedback/problem/index | feedback:problem:index | General feedback | TBModel_Feedback | — | NO | SKIP | Defer. |
| /feedback/mobile/index | feedback:mobile:index | Mobile-specific feedback | TBModel_Feedback | new `MobileFeedback`? | YES | P1 | `GET /api/backoffice/feedback/mobile`. Mobile team needs this. |
| /feedback/inbox/index | feedback:inbox:index | Placeholder | — | — | NO | SKIP | Legacy under-construction stub. |
| /sysadmin/impersonate/index | sysadmin:impersonate:index | Admin impersonate member | TBWeb_Impersonate | Member | YES | P1 | `POST /api/backoffice/members/{id}/impersonate` → returns short-lived member JWT. Audit log required. |
| /sysadmin/cache/index | sysadmin:cache:index | Cache mgmt | CCache | — | NO | SKIP | Sysops. |
| /sysadmin/config/index | sysadmin:config:index | Config viewer | CConfig | — | NO | SKIP | Use `env.ts`. |
| /sysadmin/cron/index | sysadmin:cron:index | Cron status | CQueue | — | NO | SKIP | Sysops. |
| /sysadmin/daemon/index | sysadmin:daemon:index | Daemon status | CQueue | — | NO | SKIP | Sysops. |
| /sysadmin/server/index | sysadmin:server:index | Server info | — | — | NO | SKIP | Sysops. |
| /sysadmin/log/index | sysadmin:log:index | System logs | — | — | NO | SKIP | Use pino + external log shipper. |
| /userdatatracking/optin/index | userdatatracking:optin:index | Opt-in tabs | — | — | NO | SKIP | Compliance archival. |
| /userdatatracking/optin/signup /import /registered /joined | userdatatracking:optin:* | Compliance variants | — | — | NO | SKIP | All SKIP. |
| /userdatatracking/affiliate/index | userdatatracking:affiliate:index | Affiliate tracker | TBModel_UserTracking | — | NO | SKIP | Affiliate analytics elsewhere. |
| /userdatatracking/churn/index | userdatatracking:churn:index | Churn analysis | TBModel_UserTracking | — | NO | SKIP | Defer. |
| /userdatatracking/feature/index | userdatatracking:feature:index | Feature usage | TBModel_UserTracking | — | NO | SKIP | Defer. |
| /userdatatracking/arterous/index | userdatatracking:arterous:index | Arterous logs | TBModel_UserTracking | — | NO | SKIP | 3rd-party tracker. |
| /userdatatracking/whatsapp/index | userdatatracking:whatsapp:index | WA opt-in | TBModel_UserTracking | — | NO | SKIP | Defer. |
| /data/account/index | data:account:index | BA mgmt tabs | TBModel_Account | — | NO | SKIP | Multi-tenant. |
| /data/network/index | data:network:index | Network account data | TBModel_Account | — | NO | SKIP | Multi-tenant. |
| /reloadBa/reloadBaSelect | reloadBa:reloadBaSelect | UI helper | — | — | NO | SKIP | FE concern. |

---

## Cluster summary

- **Total:** 107 endpoints.
- **P0 (8):** Admin 2FA setup + verify, home dashboard, member list, network list + datatable, tribe insight summary.
- **P1 (24):** Google SSO, OTP forgot-password, 2FA reverify/disable, member ops AJAX, search + reload, network write, network member list, push notif log, bug + user-report + mobile-feedback triage, impersonate.
- **Drops:** all multi-tenant (`data/*`, `tribe/account`, `tribe/babyTribe`), pixel integrations, i18n editor, sysops tooling, user-data-tracking compliance views, legacy email log.
- **Biggest gap vs current EJS admin:** admin 2FA + audit log, member-ops actions (impersonate, force-verify), moderation triage queues, cross-entity search.

## New Prisma tables for this cluster

- `Admin2FA`, `AdminRefreshToken`, `AdminAuditLog` (sprint 1)
- `BugReport` (sprint 6) — optional, scope w/ mobile team
- `MobileFeedback` (sprint 6) — optional
