# Backoffice Port — Cluster E: Dashboard / Insight / Integration / Setting / Monitor / Cron

Legacy scope: `tribelio-admin/default/controllers/` — `dashboard/**`, `insight/**`, `integration/**`, `setting/**`, `monitor/**`, `cron/**`, `oracle/**` (admin's oracle controllers), `creatororacle.php`, `ari.php`.

**Totals:** 56 endpoints — **P0: 6 · P1: 38 · P2: 1 · SKIP: 11**

---

## Inventory

### Dashboard

| Legacy URL | Controller:action | Purpose | Lib | Mobile-admin? | Priority | Notes |
|---|---|---|---|---|---|---|
| /dashboard/dailyActiveMember/index | dashboard:dailyActiveMember | DAU trends (month/year) | TBModel_MemberActiveHistory | YES | **P0** | `GET /api/backoffice/dashboard/dau?from=&to=`. |
| /dashboard/dailyActiveMember/reloadGraph | dashboard:dailyActiveMember/reloadGraph | DAU chart reload | same | YES | **P0** | Same endpoint, query params. |
| /dashboard/executiveSummary/index | dashboard:executiveSummary | Lifetime/period aggregates (members, posts, revenue, affiliate) | TBSummary, TBModel_SummaryRevenue | YES | **P0** | `GET /api/backoffice/dashboard/exec-summary?from=&to=`. |
| /dashboard/executiveSummary/reloadSummary | dashboard:executiveSummary/reloadSummary | Reload cards | same | YES | **P0** | Same endpoint. |
| /dashboard/executiveSummary/loadGraph7Days | dashboard:executiveSummary/loadGraph7Days | 7-day trend | TBSummary | YES | **P0** | `GET /api/backoffice/dashboard/trend-7d?metric=members\|posts\|revenue`. |
| /dashboard/executiveSummary/loadGraphRevenue | dashboard:executiveSummary/loadGraphRevenue | Revenue breakdown (method/plan/tax) | TBModel_Payment | YES | P1 | `GET /api/backoffice/dashboard/revenue?from=&to=`. |
| /dashboard/executiveSummary/loadGraphMemberSignUp | dashboard:executiveSummary/loadGraphMemberSignUp | Signup trend | TBModel_Calendar | YES | **P0** | `GET /api/backoffice/dashboard/signups?from=&to=`. |
| /dashboard/last10Days/index | dashboard:last10Days | 10-day rolling view | TBModel_MemberSummaryDay | YES | P1 | `GET /api/backoffice/dashboard/last-10d`. |
| /dashboard/last10Days/reloadGraph | dashboard:last10Days/reloadGraph | Reload chart | same | YES | P1 | Same endpoint. |
| /dashboard/memberSummary/index | dashboard:memberSummary | Top inviters, joiners, creators | TBModel_MemberStatsInvite | YES | P1 | `GET /api/backoffice/insight/leaders?type=invites\|joins\|tribesCreated`. |
| /dashboard/memberSummary/reloadSummary | dashboard:memberSummary/reloadSummary | Reload | same | YES | P1 | Same endpoint. |
| /dashboard/memberSummary/reloadMostInvite | dashboard:memberSummary/reloadMostInvite | Top inviters | same | YES | P1 | Same w/ `type=invites`. |
| /dashboard/memberSummary/reloadMostJoined | dashboard:memberSummary/reloadMostJoined | Top joiners | same | YES | P1 | Same w/ `type=joins`. |
| /dashboard/memberSummary/reloadMostCreatedTribe | dashboard:memberSummary/reloadMostCreatedTribe | Top tribe creators | same | YES | P1 | Same w/ `type=tribesCreated`. |
| /dashboard/overview/index | dashboard:overview | Financial summary (methods, plans, tax, affiliate) | TBModel_Payment | YES | P1 | `GET /api/backoffice/dashboard/finance-overview?from=&to=`. |
| /dashboard/trendingSummary/index | dashboard:trendingSummary | Top posts by engagement | TBModel_PostStats | YES | P1 | `GET /api/backoffice/insight/trending-posts?metric=likes\|comments\|shares\|stars`. |
| /dashboard/trendingSummary/reloadSummary | dashboard:trendingSummary/reloadSummary | Reload | same | YES | P1 | Same. |
| /dashboard/trendingSummary/reloadMostComment | dashboard:trendingSummary/reloadMostComment | Most commented | same | YES | P1 | Same w/ metric. |
| /dashboard/trendingSummary/reloadMostReplies | dashboard:trendingSummary/reloadMostReplies | Most replies | same | YES | P1 | Same w/ metric. |
| /dashboard/trendingSummary/reloadTopShare | dashboard:trendingSummary/reloadTopShare | Most shared | same | YES | P1 | Same w/ metric. |
| /dashboard/trendingSummary/reloadTopLike | dashboard:trendingSummary/reloadTopLike | Most liked | same | YES | P1 | Same w/ metric. |
| /dashboard/trendingSummary/reloadTopStarred | dashboard:trendingSummary/reloadTopStarred | Most starred | same | YES | P1 | Same w/ metric. |
| /dashboard/tribeSummary/index | dashboard:tribeSummary | Tribe stats (members, posts, comments) | TBModel_TribeStats | YES | P1 | `GET /api/backoffice/insight/tribes`. |
| /dashboard/tribeSummary/reloadSummary | dashboard:tribeSummary/reloadSummary | Reload | same | YES | P1 | Same. |
| /dashboard/tribeSummary/reloadMostMember | dashboard:tribeSummary/reloadMostMember | Largest tribes | same | YES | P1 | Same w/ `type=members`. |
| /dashboard/tribeSummary/reloadMostPost | dashboard:tribeSummary/reloadMostPost | Most active tribes | same | YES | P1 | Same w/ `type=posts`. |
| /dashboard/tribeSummary/reloadMostComment | dashboard:tribeSummary/reloadMostComment | Most discussed tribes | same | YES | P1 | Same w/ `type=comments`. |

### Insight

| Legacy URL | Controller:action | Purpose | Lib | Mobile-admin? | Priority | Notes |
|---|---|---|---|---|---|---|
| /insight/engagement/index | insight:engagement | Posts + activity engagement tabs | TBModel_PostStats | YES | P1 | `GET /api/backoffice/insight/engagement`. |
| /insight/growth/index | insight:growth | DEPRECATED (redirects to executiveSummary) | TBModel_MemberSummaryDay | YES | SKIP | Use exec-summary. |
| /insight/tribelio/index | insight:tribelio | Platform breakdown (Android/iOS/both/none) | TBAdmin::createInsightOracle | YES | **P0** | `GET /api/backoffice/insight/platform?from=&to=`. Single most useful mobile metric. |
| /insight/tribelio/reloadTabList | insight:tribelio/reloadTabList | Reload tab | same | YES | **P0** | Same endpoint. |
| /insight/tribelio/reloadEngagementMembers | insight:tribelio/reloadEngagementMembers | Member engagement | same | YES | P1 | `GET /api/backoffice/insight/member-engagement`. |
| /insight/tribelio/reloadEngagementMembersGrowth | insight:tribelio/reloadEngagementMembersGrowth | Member growth trend | same | YES | P1 | `GET /api/backoffice/insight/member-growth`. |

### Integration

| Legacy URL | Controller:action | Purpose | Lib | Mobile-admin? | Priority | Notes |
|---|---|---|---|---|---|---|
| /integration/whatsapp/index | integration:whatsapp | WA provider pairing status | TBModel_NetworkAccount | YES | P1 | `GET /api/backoffice/integrations/whatsapp`. |
| /integration/whatsapp/reloadTableWhatsapp | integration:whatsapp/reloadTableWhatsapp | Reload device list | same | YES | P1 | Same endpoint. |
| /integration/whatsapp/detail/{id} | integration:whatsapp/detail | Device logs | TBModel_LogWaCallback | YES | P1 | `GET /api/backoffice/integrations/whatsapp/{id}`. |
| /integration/notifi/index | integration:notifi | Notifi SMS quota | TBSms_Vendor_Notifi | YES | P1 | `GET /api/backoffice/integrations/notifi`. |
| /integration/arterous /domain /pixel /shipment | integration:* | 3rd-party trackers + web shipping | various | NO | SKIP | All web-only. |

### Monitor / Cron / Oracle (admin) / Misc

| Legacy URL | Controller:action | Purpose | Lib | Mobile-admin? | Priority | Notes |
|---|---|---|---|---|---|---|
| /monitor/usage/index | monitor:usage | MongoDB quota usage (deprecated) | MongoDB | NO | SKIP | MongoDB-only, redirects home. |
| /monitor/usage/reloadSummary | monitor:usage/reloadSummary | Reload quota | same | NO | SKIP | SKIP. |
| /monitor/usage/graphEmail | monitor:usage/graphEmail | Email quota chart | same | NO | SKIP | SKIP. |
| /cron/autoStartQueueTask/execute | cron:autoStartQueueTask | Queue daemon trigger | TBDaemon_ServerMapping | NO | P2 | Backend-only; expose `/api/backoffice/cron/trigger/{job}` for ops manual run later. |
| /oracle/automation/* | oracle:automation:* | Autoresponder mgmt | TBCreator::api | NO | SKIP | Creator-studio CRM. |
| /oracle/broadcast/* | oracle:broadcast:* | Broadcast scheduler | TBCreator::api | NO | SKIP | Creator-studio CRM. |
| /oracle/package/* | oracle:package:* | BA package mgmt | TBModel_Package, TBCreator::api | YES | P1 | If we model subscription packages (cluster B), expose CRUD here. Otherwise SKIP. |
| /setting/** | setting:* | Various settings tabs | TBSetting | partial | P1 | Map per-setting → env.ts or `AppSetting` Prisma model (already exists). Expose read-only viewer + write for `AppSetting`-backed keys only. Skip env-backed secrets. |
| /creatororacle.php | creatororacle:* | Creator-studio bridge | TBOracle::api | NO | SKIP | Creator-studio. |
| /ari.php | ari:* | Legacy debug/playground | — | NO | SKIP | Dev sandbox. |

---

## Cluster summary

- **Total:** 56 endpoints.
- **P0 (6):** DAU, exec summary, signup trend, 7-day trend, platform breakdown (Android/iOS), insight platform reload.
- **P1 (38):** revenue breakdown, 10-day rolling, member-leader boards, trending posts (5 metrics), tribe stats, engagement insight, member engagement + growth, WhatsApp + Notifi integration, oracle/package, settings viewer.
- **P2 (1):** cron trigger.
- **Drops:** MongoDB monitor, deprecated `insight/growth`, creator-studio oracle controllers, Cresenity-specific cron, arterous/pixel/shipment integrations.

## Recommended v1 dashboard tiles (≤6)

1. **Exec Summary** — total members, posts, revenue, affiliate commission (period-bounded)
2. **DAU trend** — line chart, last 30 days default
3. **Signup trend** — line chart, last 30 days
4. **Platform split** — Android / iOS / both / none (cumulative + period delta)
5. **Top tribes (by members + posts)** — table top-10
6. **Trending posts** — table top-10 (filter: likes/comments/shares)

## New Prisma tables for this cluster

- `AppSetting` already exists (`prisma/schema.prisma:1040`) — reuse for settings viewer/editor.
- `PushDeliveryLog` (sprint 6, optional) — if FCM provider doesn't expose enough delivery telemetry, capture via webhook into this table: `{ id, notificationId, providerMessageId, status, error, deliveredAt, createdAt }`.

## Implementation notes

- Most legacy dashboard endpoints share data shape; collapse into ≤8 backoffice endpoints with `metric=` / `type=` query params instead of 30+ per-AJAX-reload routes.
- Use materialized views or computed columns for hot aggregates if Postgres struggles. Start w/ live SQL — measure first.
- `insight/tribelio` (platform breakdown) currently fetches from legacy Oracle remote. New: compute directly from `Member` + `Device` join in single-tenant Postgres.
