# Promo Version Window (Mobile) — FE Contract

Lets us run a promo in **production** that only our internal app build sees, while
users on the public app do not. The web shop in a normal browser is never affected.

- **Endpoint:** `GET /api/member/promo/public` (already live; see
  `docs/banner-webview-promo-contract.md` §2 for the response).
- **Change:** two optional query parameters. Nothing else changes: same response
  shape, same auth (optional), and a request without the new parameters behaves
  exactly as before.
- **Status:** built on branch `feat/promo-version-gate`, not deployed yet.
- **Internal spec:** `docs/promo-landing.md` §Version gate.

---

## 1. Request

```
GET /api/member/promo/public?platform=android&version=3.3.2
```

| Param | Values | Notes |
| --- | --- | --- |
| `platform` | `android` \| `ios` | Send it **only** when the page runs inside the app. Omit it on the plain web. |
| `version` | app version, semver (`3.3.2`) | The installed app version. Same params as `GET /api/member/data/banner`. |

Both are optional and read as-is: an unknown or malformed value never causes a
`400`.

## 2. Rules (BE)

| Request | Result |
| --- | --- |
| No `platform`, or anything other than `android`/`ios` (plain web) | Never gated: every active promo, as today. |
| `platform` set, no window configured for that platform | Every active promo, as today. |
| `platform` set, window on, `version` inside it (both bounds inclusive) | Every active promo. |
| `platform` set, window on, `version` outside it | `data: []` |
| `platform` set, window on, `version` missing or not semver | `data: []` |

- The window is configured by BE/ops, separately for Android and iOS, as a minimum
  and/or maximum version. Either bound may be empty (= unbounded).
- It is **global**: it hides or shows all promos at once, not one promo.
- Changes take effect within ~30 seconds, with no deploy and no app release.
- Versions compare numerically per segment (`3.10.0` is newer than `3.3.0`).
- A hidden list is a normal `200` with `success: true` and `data: []`. FE shows the
  existing "not found or ended" state.

## 3. What FE needs to do

The promo page is a web page opened in a webview, so the app's version never
reaches it on its own.

1. **App:** when opening a promo link inside the app (a `webview` banner or any
   other entry point), append `platform` and `version` to the URL:
   `https://shop.brainboost.id/promo/oktober?platform=android&version=3.3.2`
2. **Web page:** if the page URL carries `platform` and `version`, forward both
   unchanged to `GET /api/member/promo/public`. If it does not, call the endpoint
   without them, as today.
3. The web page must **not** fill in `platform` by itself (for example from the
   user agent). A page opened in a normal browser has to stay ungated.

Without steps 1 and 2 the window has no effect in the app: the page calls the API
without `platform`, which counts as the web.

## 4. Example

The store is on 3.3.1 and the internal build is 3.3.2. Ops sets the minimum to
`3.3.2` on both platforms.

| Who | Request | Sees the promo |
| --- | --- | --- |
| Internal build | `?platform=android&version=3.3.2` | Yes |
| Public app | `?platform=android&version=3.3.1` | No |
| App page opened without the params | (none) | Yes, counts as the web |
| Plain web browser | (none) | Yes |

To go live, ops clears the window. Before 3.3.2 ships to the store, either the
promo is ready or the minimum is raised.

## 5. Things to know

- **Visibility, not access control.** Anyone can put
  `?platform=android&version=99.0.0` on the URL, and the voucher code still works at
  checkout for whoever has it.
- **Banners are separate.** This window only covers the promo endpoint. A test
  banner that links to a hidden promo is scoped with the banner's own version window
  — see `docs/banner-version-window-contract.md`.

## 6. What BE needs back from FE

- Confirmation that the app appends `platform` + `version` to promo webview URLs,
  and from which app version.
- Confirmation that the web page forwards them to the API and never sets
  `platform` on its own.
