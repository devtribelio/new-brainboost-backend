# Backoffice Port — Cluster D: Affiliate / Bot / Campaign

Legacy scope: `tribelio-admin/default/controllers/` — `affiliate/**` (brainboost, commission, contest, history, list, summary), `campaign/**` (blacklist, broadcast, creator, responder), `bot/**` (reminderba, weeklychief, reminderbatab, weeklychieftab), `automation*`, `broadcast*`, `smartlist*`.

**Totals:** 26 endpoints — **P0: 7 · P1: 4 · SKIP: 15**

---

## Inventory

| Legacy URL | Controller:action | Purpose | Lib | New entity | Mobile-admin? | Priority | Notes |
|---|---|---|---|---|---|---|---|
| /affiliate/brainboost | Affiliate:Brainboost:index | List super-affiliators by signup date | TBModel_MemberNetworkConnect | new `AffiliateConnection`? | YES | **P0** | `GET /api/backoffice/affiliate/connections?signupFrom=&signupTo=`. |
| /affiliate/brainboost/delete/{id} | Affiliate:Brainboost:delete | Remove affilator connection | TBModel_MemberNetworkConnect | AffiliateConnection | YES | **P0** | `DELETE /api/backoffice/affiliate/connections/{id} { reason }`. Audit log + optional reason. |
| /affiliate/list | Affiliate:List:index | List all affiliates by parent/period | member (raw SQL) | Member + AffiliateProgram | YES | **P0** | `GET /api/backoffice/affiliate/members?parentId=&from=&to=`. Read-only roster. |
| /affiliate/summary | Affiliate:Summary:index | Stats (commission sums, L1-L2 tree, bank filter) | member_commision (raw SQL) | AffiliateCommission | YES | **P0** | `GET /api/backoffice/affiliate/summary?from=&to=&bankId=`. Includes Excel export. |
| /affiliate/commission/index | Affiliate:Commission:index | Commission summary + tree tabs | member_commision (raw SQL) | AffiliateCommission | YES | **P0** | `GET /api/backoffice/affiliate/commissions/summary` + `/tree`. Tax calc. |
| /affiliate/commission/reloadTableSummary | Affiliate:Commission:reloadTableSummary | Paginated summary | same | AffiliateCommission | YES | P1 | Same endpoint, params: date range, bank, signup date. |
| /affiliate/commission/downloadpdf | Affiliate:Commission:downloadpdf | Commission summary PDF | same | AffiliateCommission | YES | P1 | `GET /api/backoffice/affiliate/commissions/summary.pdf`. Finance ops use. |
| /affiliate/commission/reloadTabAllTree | Affiliate:Commission:reloadTabAllTree | Hierarchical commission tree | same | AffiliateCommission | YES | P1 | `GET /api/backoffice/affiliate/commissions/tree?memberId=`. |
| /affiliate/history/index | Affiliate:History:index | Commission transaction history | member_commision (raw SQL) | AffiliateCommission | YES | P1 | `GET /api/backoffice/affiliate/history?memberId=&from=&to=`. |
| /affiliate/history/reloadExport | Affiliate:History:reloadExport | Export history CSV | same | AffiliateCommission | YES | P1 | `GET /api/backoffice/affiliate/history.csv`. |
| /affiliate/history/reloadPdf | Affiliate:History:reloadPdf | Export history PDF | same | AffiliateCommission | YES | P1 | `GET /api/backoffice/affiliate/history.pdf`. |
| /affiliate/contest/index | Affiliate:Contest:index | Contest leaderboard (legacy stub: under construction) | — | — | YES | P2 | Skip until contest feature spec lands. |
| /campaign/blacklist/* | Campaign:Blacklist:* | Email campaign blacklist | TBModel_* | — | NO | SKIP | Email blast tool, web-only. |
| /campaign/broadcast/index | Campaign:Broadcast:index | Email broadcast dashboard | TBModel_* | — | NO | SKIP | Email blast, not mobile. |
| /campaign/responder/index | Campaign:Responder:index | Auto-responder dashboard | TBModel_* | — | NO | SKIP | Email automation, not mobile. |
| /campaign/creator/* | Campaign:Creator:* | Creator referral campaign | TBModel_CreatorCampaign | — | NO | SKIP | Creator-studio product. |
| /bot/reminderba/index | Bot:ReminderBA:index | BA expiry reminder daemon | TG/WA daemons | — | NO | SKIP | Messaging automation, not mobile scope. |
| /bot/weeklychief/index | Bot:WeeklyChief:index | Weekly report daemon | TG/WA daemons | — | NO | SKIP | Messaging automation. |
| /bot/reminderbatab/history /summary | Bot:ReminderBATab:* | BA reminder tabs | TG/WA | — | NO | SKIP | Same. |
| /bot/weeklychieftab/history /summary | Bot:WeeklyChiefTab:* | Weekly chief tabs | TG/WA | — | NO | SKIP | Same. |
| /oracle/automation/index | Oracle:Automation:index | Email/SMS automation sequences | Flow engine | — | NO | SKIP | Creator-studio CRM. |
| /oracle/broadcast/index | Oracle:Broadcast:index | Email broadcast hub | Email | — | NO | SKIP | Creator-studio. |
| /oracle/smartlist/index | Oracle:Smartlist:index | CRM segmentation | CRM engine | — | NO | SKIP | Creator-studio. |
| /disbursement/affiliate/index | Disbursement:Affiliate:index | Payout history + upcoming | member_disbursement | AffiliateDisbursement | YES | **P0** | Already covered in cluster C — see `cluster-c-finance.md`. |
| /member/addSmartlist | member:addSmartlist | Add member to smartlist | — | — | NO | SKIP | CRM tool. |
| /member/smartlist | member:smartlist | Member smartlist UI | — | — | NO | SKIP | CRM tool. |

---

## Cluster summary

- **Total:** 26 endpoints.
- **P0 (7):** brainboost list + delete, affiliate list, summary, commission summary + tree, disbursement payout history (covered in cluster C).
- **P1 (4):** commission export PDF, commission tree reload, history export CSV/PDF.
- **Drops:** all campaign/email-blast tools, all bot daemons, smartlist CRM, creator-studio automation/broadcast.
- **New affiliate-admin gaps vs current new affiliate module:**
  1. No admin payout approve/reject API (currently member-facing request/list only). Cover in cluster C.
  2. No manual performance-tier override (force-tier-down from PERFORMANCE to INACTIVE).
  3. No attribution force-rebind (manual last-touch override).
  4. No manual commission adjust (negative-amount correction for finance).
  5. No connection-removal audit (`AffiliateConnectionRemovalLog`).

## New Prisma tables / schema patches

- `AffiliateConnection` (sprint 4) — formalize the `MemberNetworkConnect` relationship: `{ id, memberId, parentMemberId, networkId, joinedAt, removedAt, removalReason, removedById }`. If existing relation already covers this in `affiliate.service`, just add `removedAt` + `removalReason`.
- `AffiliateCommissionAdjustment` (sprint 4) — manual correction: `{ id, originalCommissionId, amountDelta, reason, createdById, createdAt }`.
- `AffiliateAttributionOverride` (sprint 4, optional) — `{ id, memberId, newParentId, oldParentId, reason, createdById, createdAt }`.

## Integration notes

- PDF generation: pick `pdfkit` or `puppeteer`. `pdfkit` enough for tabular reports.
- CSV: stream via `node:stream` + `csv-stringify`. Don't buffer entire query result.
- Commission tree (L1-L2): existing recursive CTE pattern lives at `src/modules/affiliate/utils/walk-inviter-chain.ts`. Reuse + adapt for downstream (children) walk.
- Aggregations are read-heavy; protect Postgres w/ indexed columns on `created_at`, `member_id`, `parent_member_id`.
