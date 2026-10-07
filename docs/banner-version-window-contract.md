# Banner Version Window — FE Contract

Lets us run a banner in **production** that only our internal app build sees, while
users on the public app do not. Typical use: a promo banner tested before launch,
together with the promo window in `docs/promo-version-gate-contract.md`.

- **Endpoint:** `GET /api/member/data/banner` (unchanged URL and response shape).
- **Change:** each banner can now carry its own app version window, set in the
  backoffice. Banners without one behave exactly as before.
- **Status:** built on branch `feat/promo-version-gate`, not deployed yet.
- **Internal spec:** `docs/promo-landing.md` §Banner version window.

---

## 1. Request

No new parameters. The app already sends these since the banner version gate:

```
GET /api/member/data/banner?platform=android&version=3.3.2
```

| Param | Values | Notes |
| --- | --- | --- |
| `platform` | `android` \| `ios` | Required for a windowed banner to ever appear. |
| `version` | app version, semver (`3.3.2`) | The installed app version. |

## 2. Rules (BE)

Each banner has an optional window per platform: a minimum and/or maximum version,
both inclusive. An empty bound is unbounded.

| Banner | Request | Result |
| --- | --- | --- |
| No window (every existing banner) | anything | Shown, as today. |
| Has a window | `platform` + `version` inside that platform's window | Shown. |
| Has a window | `platform` + `version` outside it | Not in the list. |
| Has a window, but none for the client's platform | `platform` + any `version` | Shown (no bound for that platform). |
| Has a window | no `platform`, or not `android`/`ios` | **Not in the list.** |
| Has a window | `platform` without `version`, or a version that is not semver | Not in the list. |

- The existing global gate still applies first: a build newer than
  `banner.maxVersion*` gets no banners at all.
- A banner left out is simply absent; the response stays `200`, and
  `meta.pagination.total` counts only the banners the client actually receives.
- The window itself is not returned in the response.

**Why a windowed banner is hidden without `platform`:** app builds older than the
banner version gate call this endpoint with no parameters, and BE cannot tell them
apart from the web. Hiding is the only way to keep a test banner off those builds.
This is different from the promo endpoint, where a request without `platform`
counts as the web and is not gated.

## 3. What FE needs to do

- **App:** keep sending `platform` and `version` on every call to this endpoint, as
  today. Nothing new.
- **Web (if it uses this endpoint):** no change. It will not see windowed banners,
  which is the intent.

## 4. Example

Store is on 3.3.1, internal build is 3.3.2. Ops creates the promo banner with
minimum version `3.3.2` for Android and iOS.

| Who | Request | Sees the test banner |
| --- | --- | --- |
| Internal build | `?platform=android&version=3.3.2` | Yes |
| Public app | `?platform=android&version=3.3.1` | No |
| App build older than the banner gate | (none) | No |
| Web | (none) | No |

Other banners are unaffected in every row. To go live, ops clears the window on that
banner. Before 3.3.2 ships to the store, either the banner is ready or the minimum is
raised.

## 5. Things to know

- **Visibility, not access control.** Anyone can call the endpoint with
  `?platform=android&version=99.0.0`.
- **The banner and the promo are gated separately.** To test a promo banner, set both
  the banner's window (this document) and the promo window
  (`docs/promo-version-gate-contract.md`). The promo page inside the app also needs
  `platform` + `version` forwarded, or it counts as the web.

## 6. What BE needs back from FE

- Confirmation that every app version that should see test banners sends
  `platform` + `version` on `GET /data/banner`.
