# Backoffice Port — Cluster B: Course / Content / CMS

Legacy scope: `tribelio-admin/default/controllers/` — `course.php`, `course/**` (bundle, moderation, preview, sales, thirdparty), `canvas.php`, `media.php`, `medias.php`, `posts.php`, `workshop.php`, `package.php`, `cms/**`, `shop/**`, `event/**`.

**Totals:** 60 endpoints — **P0: 9 · P1: 14 · P2: 2 · SKIP: 35**

---

## Inventory

| Legacy URL | Controller:action | Purpose | Lib | New entity | Mobile-admin? | Priority | Notes |
|---|---|---|---|---|---|---|---|
| /course | course:index | Empty stub | — | — | NO | SKIP | No logic. |
| /course/bundle | course/bundle:index | Bundle sales w/ date/source filters | TBModel_ProductBundlePaymentDetail | ProductBundle (new) | YES | **P0** | `GET /api/backoffice/sales/bundles?from=&to=&source=`. Aggregates affiliate split. |
| /course/bundle | course/bundle:reloadTableSales | Paginated bundle sales | same | ProductBundle | YES | **P0** | Same endpoint, pagination. |
| /course/bundle | course/bundle:reloadDetailAffiliator | Modal: affiliate split by level | TBModel_AffiliatorCommision | AffiliateCommission | YES | **P0** | `GET /api/backoffice/sales/transactions/{id}/affiliate-split`. |
| /course/sales | course/sales:index | Multi-product sales (course/book/digital) | TBModel_Transaction etc. | Product sales | YES | **P0** | `GET /api/backoffice/sales?type=&platform=&source=`. |
| /course/sales | course/sales:reloadTableSales | Paginated sales | same | Product sales | YES | **P0** | Same endpoint, pagination. |
| /course/sales | course/sales:reloadDetailAffiliator | Modal: affiliate split | TBModel_AffiliatorCommision | AffiliateCommission | YES | **P0** | Same as bundle variant. |
| /course/moderation | course/moderation:index | Tabs: powerup + super-affiliate moderation | — | — | YES | **P0** | UI tab; backend: two list endpoints. |
| /course/moderation | course/moderation:powerup | Powerup in-review queue | TBModel_PowerupRequest | PowerupRequest (new) | YES | P1 | `GET /api/backoffice/moderation/powerup?status=IN_REVIEW`. |
| /course/moderation | course/moderation:reloadTableCourseModeration | Paginated powerup | same | PowerupRequest | YES | P1 | Same endpoint, pagination. |
| /course/moderation | course/moderation:moderationApproved | Approve powerup | TBCourse | PowerupRequest | YES | P1 | `PUT /api/backoffice/moderation/powerup/{id}/approve`. Atomic txn + email. |
| /course/moderation | course/moderation:rejectedRequest | Reject powerup (reason max 500) | TBCourse | PowerupRequest | YES | P1 | `PUT /api/backoffice/moderation/powerup/{id}/reject { reason }`. |
| /course/moderation | course/moderation:modalPowerupRejected | Reject modal | — | — | YES | SKIP | UX only — FE renders. |
| /course/moderation | course/moderation:superProduct | Super-affiliate list | TBModel_NetworkAccountProductAffiliator | Course.isSuperAffiliate flag (new) | YES | P1 | `GET /api/backoffice/moderation/super-affiliate?status=`. |
| /course/moderation | course/moderation:reloadTableSuperProduct | Paginated | same | same | YES | P1 | Same endpoint, pagination. |
| /course/moderation | course/moderation:active | Promote super-affiliate | TBCourse::promote | Course | YES | P1 | `PUT /api/backoffice/moderation/super-affiliate/{id}/promote`. |
| /course/moderation | course/moderation:inActive | Unpromote | TBCourse::unpromote | Course | YES | P1 | `PUT /api/backoffice/moderation/super-affiliate/{id}/unpromote`. |
| /course/preview | course/preview:lookup | Type-route powerup preview | TBModel_PowerupRequest | — | NO | SKIP | Routing helper; FE does this. |
| /course/preview | course/preview:lookupCourse | Route super-product preview | TBModel_NetworkAccountProductAffiliator | — | NO | SKIP | FE concern. |
| /course/preview | course/preview:course | Course detail w/ lessons | TBCourse, TBCourse_Lesson | Course | YES | P2 | `GET /api/backoffice/courses/{id}/preview` — admin view of lessons tree. |
| /course/thirdparty | course/thirdparty:index | Lynk.id integrations list | — | — | NO | SKIP | Out of scope. |
| /course/thirdparty | course/thirdparty:reloadTable | (stub) | — | — | NO | SKIP | Out of scope. |
| /canvas | canvas:index | Page builder list | TBModel_Canvas | — | NO | SKIP | Web-only page builder. |
| /canvas | canvas:reloadTableCanvas | Paginated canvases | TBModel_Canvas | — | NO | SKIP | SKIP. |
| /canvas | canvas:delete | Delete canvas | TBModel_Canvas | — | NO | SKIP | SKIP. |
| /canvas | canvas:deleteMultiple | Bulk delete canvases | TBModel_Canvas | — | NO | SKIP | SKIP. |
| /media | media:index | S3 presigned-URL stub (broken) | AWS S3 | — | NO | SKIP | Replaced by `/medias` (also out of scope here). |
| /medias | medias:index | S3 presigned-URL gen | AWS S3 | — | NO | SKIP | New backend uses Bunny (see `media` module). Direct upload via mobile, admin doesn't need this. |
| /posts | posts:index | Posts curation list w/ engagement counts | TBAdmin trait | Post | YES | **P0** | `GET /api/backoffice/posts?from=&to=&q=&sort=likes\|comments\|shares`. EJS admin has CRUD but no curation view. |
| /workshop | workshop:index | Workshop orders | TBModel_Workshop | new `Workshop`? | YES | P1 | If workshops in scope: `GET /api/backoffice/workshops/orders`. Check w/ product team. |
| /workshop | workshop:reloadTable | Paginated workshop orders | same | same | YES | P1 | Same endpoint. |
| /package | package:index | Multi-link subscription package mgmt | TBModel_Package | new `SubscriptionPackage`? | YES | **P0** | `GET /api/backoffice/packages?from=&to=`. Monthly tier mgmt. |
| /package | package:reloadFilter | Paginated packages | same | same | YES | **P0** | Same endpoint. |
| /package | package:add | Create package | same | same | YES | P1 | `POST /api/backoffice/packages`. |
| /package | package:edit | Update package | same | same | YES | P1 | `PUT /api/backoffice/packages/{id}`. |
| /package | package:delete | Soft-delete package | same | same | YES | P1 | `DELETE /api/backoffice/packages/{id}`. |
| /cms/blog /blogcategory /landingpage /landingpagev2 /package /popupslideshow /techclass /affiliate | cms:* | Blog/landing-page CMS | TBModel_* | — | NO | SKIP | All web-only marketing content. |
| /shop/manageTribe | shop/manageTribe:index | Shop orders by tribe | TBModel_ShopOrder | — | NO | SKIP | Tribe-level shop, not mobile. |
| /event/manageTribe | event/manageTribe:index | Event orders by tribe | TBModel_EventOrder | — | NO | SKIP | Tribe-level event, not mobile. |

---

## Cluster summary

- **Total:** 60 endpoints.
- **P0 (9):** bundle sales list + pagination + affiliate-split modal, course sales list + pagination + affiliate-split modal, moderation tabs index, posts curation list, package list + pagination.
- **P1 (14):** powerup approve/reject + queue, super-affiliate list + promote/unpromote, workshop orders, package write actions.
- **P2 (2):** course preview detail (admin-side lessons tree).
- **Drops:** canvas (page builder), all `cms/*` (web marketing), media S3 stubs, tribe-level shop/event orders, Lynk.id third-party.
- **Biggest gaps vs new admin:** sales analytics w/ affiliate split (revenue × commission breakdown), moderation workflow (state machine), package subscription tiers (not yet modelled).

## New Prisma tables for this cluster

- `PowerupRequest` (sprint 4): `{ id, courseId, requesterId, marketingKitUrl, landingPageUrl, status (IN_REVIEW/APPROVED/REJECTED), reviewedBy, reviewedAt, rejectionReason }`
- `SubscriptionPackage` (sprint 6 if in scope): `{ id, name, linkUrl, price, monthPlan, isActive, createdById }`
- `Course.isSuperAffiliate` (boolean) — sprint 4 schema patch
- `Workshop` + `WorkshopOrder` (sprint 6, only if product confirms)

## Integration notes

- Sales endpoints need union over `CommerceTransaction` × product types. Pre-compute is overkill for v1 — start w/ live SQL aggregation, optimize later.
- Powerup approval must emit a domain event (e.g. `course.powerup.approved`) → notification (per `notification` module pattern) + email if mailer in place.
- Posts curation already has `isCurated` flag (commit `aef4afa`). Backoffice endpoint just exposes filtered list w/ engagement counts.
