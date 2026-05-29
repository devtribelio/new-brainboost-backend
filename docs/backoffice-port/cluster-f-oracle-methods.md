# Backoffice Port — Cluster F: Oracle API methods (`/api/oracle/*`)

Legacy scope: `tribelio-platform/cresenity-app/application/tribelio/default/libraries/TBApi/Oracle/Method/` — dispatched via `Controller_Api::oracle($method)` in `controllers/api.php:116` (POST `/api/oracle/<method>` → `TBApi::instance(TBApi::GROUP_ORACLE)->exec($method)`).

**Totals:** 8 methods — **P0: 2 · P1: 2 · SKIP: 4**

These are JSON RPC-style endpoints the legacy admin web app consumed. They cross-cut other clusters (search, tribe insight, business-account creation). Listed separately because the dispatcher pattern is distinct.

---

## Inventory

| Method | Legacy path | Params | Output keys | Backing model | org_id scoped? | New entity | Already in CRUD? | Priority | Notes |
|---|---|---|---|---|---|---|---|---|---|
| GetTribe | Oracle/Method/GetTribe.php | keyword, page, perPage, typeFilter | total, lastPage, perPage, currentPage, items[networkId, name] | Network + network_account JOIN | YES | Network | YES | SKIP | Duplicate of `GET /api/backoffice/networks?q=`. Drop. |
| GetTribeList | Oracle/Method/GetTribeList.php | signUpDateStart/End, createdDateStart/End, openDateStart/End, keyword, commerceOracleStatus, page, perPage | total, …, items[networkId, tribeName, chief, email, phone, BACreatedDate, BAExpired, storeName, totalRevenueThisMonth, totalRevenueLastMonth, totalMember] | Network + Member + Product + NetworkCommerce + revenue subqueries | YES | Network + AffiliateCommission + Product | partial | **P0** | `GET /api/backoffice/insight/tribes`. Revenue-windowed aggregates + chief lookup. Drop `org_id`. Move impl into `insight.service`. |
| GetMemberTribeList | Oracle/Method/GetMemberTribeList.php | networkId, page, perPage, keyword | total, …, items[memberName, email, joinDate, cityName, age, imageUrl] | NetworkMember + Member + City JOIN | NO | Member + NetworkMember + City | YES (partial) | SKIP | EJS admin has `network-members` CRUD; add city/age columns via `?include=profile`. |
| GetMemberInsightMobileUser | Oracle/Method/GetMemberInsightMobileUser.php | dateStart, dateEnd, viewType (table/summary), page, perPage, signInType (android/ios/both/none/joined) | summary: countAndroid, countIos, countAndroidOnly, countIosOnly, countAndroidIos, countNotAndroidIos, countJoined; table: items[memberId, name, email, phone, cityName, birthdate, age, joinDate, signInDate] | Member + CloudMessaging + Device complex LEFT JOIN w/ platform aggregation | NO | Member + Device | NO | P1 | `GET /api/backoffice/insight/platform?viewType=summary\|table&signInType=…`. Mobile device analytics. |
| Login | Oracle/Method/Login.php | authId (SHA1), oldSessionId, appVersion | sessionId | Org (auth lookup) | NO | — | N/A | SKIP | Legacy session bootstrap. Replaced by `backoffice-auth.controller.ts` JWT flow. |
| Search | Oracle/Method/Search.php | keyword, type (post/member/comment/network/all), networkId, page, perPage | total, items{post[], topic[], member[], comment[]} | Post + Member + Comment + Network multi-model | NO | Post + Member + Comment + Network | partial | P1 | `GET /api/backoffice/search?q=&type=post\|member\|comment\|network\|all`. Single endpoint, dispatch by type. |
| GetTribeName | Oracle/Method/GetTribeName.php | networkId, page, perPage | total, …, items[networkId, name] | Network single-field lookup | NO | Network | YES | SKIP | Trivial; use existing networks CRUD. |
| CreateBussinesAccount | Oracle/Method/CreateBussinesAccount.php | memberId, nameBussinesAccount, industryId, tags, monthPlan, type (manual/auto), imageUpload, price, packageId | (success/error + side effects) | NetworkAccount + SubscriptionPayment + Member + Plan + NetworkAccountIndustry transaction | YES | partial (Member exists; NetworkAccount + SubscriptionPayment new) | NO | **P0** | `POST /api/backoffice/business-accounts`. Multi-step txn: create NetworkAccount + SubscriptionPayment + email + balance trigger. Single-tenant: drop `org_id`. |

---

## Cluster summary

- **Total:** 8 methods.
- **P0 (2):** GetTribeList (tribe insight w/ revenue rollup), CreateBussinesAccount (tribe onboarding multi-step).
- **P1 (2):** GetMemberInsightMobileUser (device split), Search (cross-entity).
- **SKIP (4):** GetTribe, GetMemberTribeList, GetTribeName (all duplicates of CRUD), Login (replaced by JWT).

## Dispatcher pattern — DO NOT port

Legacy uses reflection-based dispatch:

```php
$className = 'TBApi_' . $this->apiGroup . '_Method_' . str_replace('/', '_', $method);
$methodObject = new $className(...);
$methodObject->execute();
```

Per-method-class indirection adds zero value in TypeScript single-tenant. Use flat REST routes via `bindRoute(...)`:

```ts
// src/modules/backoffice/insight/insight.routes.ts
bindRoute({ router, controller, method: 'get', path: '/insight/tribes', handlerKey: 'tribeInsight' });
bindRoute({ router, controller, method: 'get', path: '/insight/platform', handlerKey: 'platformInsight' });

// src/modules/backoffice/search/search.routes.ts
bindRoute({ router, controller, method: 'get', path: '/search', handlerKey: 'crossEntitySearch' });

// src/modules/backoffice/business-account/business-account.routes.ts
bindRoute({ router, controller, method: 'post', path: '/business-accounts', handlerKey: 'create' });
```

## Where each method lands in the new module tree

| Legacy method | Backoffice module | File |
|---|---|---|
| GetTribeList | `insight/` | `insight.controller.ts` → `tribeInsight()` |
| GetMemberInsightMobileUser | `insight/` | `insight.controller.ts` → `platformInsight()` |
| Search | `search/` | `search.controller.ts` → `crossEntitySearch()` |
| CreateBussinesAccount | `business-account/` (new submodule, sprint 4 or later) | `business-account.controller.ts` → `create()` |

`business-account` may not exist as a concept yet in new repo (single-tenant). Confirm w/ product whether "BA" semantics map to a new `SubscriptionPackage` purchase or get dropped entirely. If dropped, downgrade `CreateBussinesAccount` to SKIP.
