# Media — Model C Migration Plan (signed-URL)

> **Status:** CODE IMPLEMENTED — the signed-URL path ships behind `MEDIA_MODE` (default
> `proxy`, so runtime behaviour is unchanged). Backend still serves Model B (byte proxy).
> Flipping to `signed` needs the new library populated + the DB `guid` rewrite (§11) + the
> env swap (§6).

## 0. How to use this document

When the preconditions in **§2** are met, the implementation can be run directly:
"read `docs/specs/media-model-c-migration.md` and implement". Steps §5–§7 are file-by-file and
ordered. Do **not** start until every box in §2 is ticked — Model C without Token
Authentication enabled is just Model A (no access control).

Background context: `docs/specs/media-port.md` (the Model B implementation + the Bunny audit) and
`docs/specs/legacy-providers.md` (BunnyCDN entry).

---

## 1. Why Model C

Model B proxies every media byte through the backend — see `docs/specs/media-port.md` §7 for the
full limitation list (2× bandwidth, latency, streaming bottleneck, no edge cache, SPOF).

Model C: the backend verifies access and returns a **short-lived signed Bunny URL**; the
client streams **directly from the Bunny edge**. This removes bandwidth, latency, the
streaming bottleneck, the edge-cache loss and most of the ops burden, and restores adaptive
bitrate (signed HLS). The only thing it gives up vs Model B: the `guid` becomes visible in
the signed URL — which is harmless **once Token Authentication is on**, because an unsigned
URL is rejected by Bunny.

---

## 2. Preconditions — verify ALL before implementing

- [ ] **Token Authentication can be enabled without breaking legacy.** The Bunny Stream
      library `157244` is **shared** with the legacy app (`tribelio-platform`), which plays
      via the unsigned WebView iframe embed. Enabling Token Authentication is library-wide
      and will `403` every unsigned consumer. One of these must hold:
  - legacy app fully retired, **or**
  - the Bunny Stream Security tab exposes **separate** toggles for *embed access* vs
    *direct/CDN file access*, legacy uses only the embed, and only the direct-file token is
    enabled, **or**
  - a **new dedicated Bunny Stream library** (Token Auth on) has been created and the course
    assets migrated to it (re-upload, or Bunny "fetch from URL" against the old CDN host).
- [ ] **Token Authentication Key** obtained from the Bunny dashboard (Stream → library
      `157244` → Security) and placed in `.env` as `BUNNY_STREAM_TOKEN_KEY` (secret — never
      commit).
- [ ] **Token Authentication is ENABLED** on the library (or the new library).
- [ ] **Signing algorithm confirmed** against current Bunny docs (see §4) — Bunny has
      changed token schemes before; verify with a live probe.
- [x] **Transport decided** — signed **HLS** (`playlist.m3u8` + directory `token_path`).

If the first box cannot be satisfied, **stay on Model B** — do not proceed.

### Decisions locked (2026-05-21)

- **New-library path chosen.** A new Bunny Stream library `666592` (CDN host
  `vz-f594ac4d-255.b-cdn.net`, pull zone `5895234`) holds the Model C content. The legacy
  library `157244` is untouched → the legacy app keeps working, no cutover dependency.
- **Token Authentication already ON** on `666592` — probed 2026-05-21: an unsigned
  `playlist.m3u8` returns `403` even with a `Referer` header (true token auth, not
  referrer-gating). The legacy `157244` stays referrer-gated only.
- **Transport: signed HLS**, directory token over `/{guid}/`.
- **Consequence — §11.** A new library mints new `guid`s; the DB `slidesData` still points
  at the old `157244` guids and must be rewritten before the flip.

---

## 3. Design

Keep the existing opaque media token and the existing endpoint. Model C changes only what
the endpoint *does*.

- **Serializer — no change.** `product.serializer.ts` keeps emitting
  `streamUrl = /api/member/media/stream?t={opaqueToken}`. The opaque AES-GCM token
  (`media-token.util.ts`) is unchanged — it still hides the `guid` from the course-detail
  response and carries `{ guid, courseId, isPreview }`.
- **Endpoint — same path, new behaviour.** `GET /api/member/media/stream?t=…`:
  - **Model B** (today): proxy the upstream bytes.
  - **Model C**: verify token → gate (enrollment for non-preview) → compute a signed Bunny
    URL → **`302` redirect** to it.
  - A `302` keeps the **frontend contract identical** between B and C — the player follows
    the redirect and streams from Bunny. The FE never has to change when the mode flips.
- **Feature flag `MEDIA_MODE=proxy|signed`.** Both code paths ship together; the env var
  selects one. The migration is then an env flip, instantly reversible — no redeploy, no
  code change at cutover.
- **Access control unchanged.** Preview → no enrollment check; non-preview → `CourseEnrollment`
  lookup. Same as Model B. The check runs on every `/media/stream` hit, before the redirect.
- **guid exposure.** The `302 Location` contains `vz-…b-cdn.net/{guid}/…?token=…`. Acceptable:
  with Token Auth on, the URL is useless without the signature, and it expires.

### Flow (Model C)

```
client → GET /api/member/media/stream?t={token}   [+ Bearer]
  backend: verifyMediaToken(t) → { guid, courseId, isPreview }
           if !isPreview → assertEnrollment(courseId, memberId)   (401/403)
           signed = signBunnyUrl(guid)               # §4
           302 Location: https://vz-5439ef3e-878.b-cdn.net/{guid}/playlist.m3u8?token=…&expires=…
client → follows redirect, streams HLS directly from the Bunny edge
```

For HLS, Bunny rewrites the segment URIs inside the returned `.m3u8` to carry their own
tokens, so one signed playlist request covers the whole stream.

---

## 4. Bunny token signing algorithm

Bunny CDN URL Token Authentication (used by Stream pull zones). **Verify against
<https://docs.bunny.net/docs/cdn-token-authentication-basics> at implementation time** and
confirm with a live probe (a signed URL must return `200`, an unsigned one `403`).

```
expires      = floor(Date.now()/1000) + ttlSeconds
hashableBase = BUNNY_STREAM_TOKEN_KEY + signedPath + expires        # signedPath e.g. /{guid}/playlist.m3u8
token        = base64( sha256_raw(hashableBase) )
token        = token.replaceAll('\n','').replaceAll('+','-').replaceAll('/','_').replaceAll('=','')
signedUrl    = https://{cdnHost}{signedPath}?token={token}&expires={expires}
```

- **Directory token** — to cover every file under `/{guid}/` with one token (HLS playlist +
  segments), Bunny supports a `token_path` form: hash over `tokenKey + token_path + expires`
  and append `&token_path=/{guid}/`. Confirm the exact form from Bunny docs.
- **TTL** — short for streaming (e.g. 1–2 h). For offline download, mint with a longer TTL
  (the player keeps the URL it received; once HLS playback starts within the window Bunny
  generally lets it continue).

Implement signing in a small util (`src/modules/media/bunny-sign.util.ts`) with a unit test
that asserts a known `(key, path, expires)` triple produces a stable token.

---

## 5. Code changes (file-by-file)

> **STATUS: implemented.** All files below exist. `MEDIA_MODE` defaults to `proxy`, so the
> signed path is dormant until the flip. `bunny-sign.util.ts` is new and uses the directory
> `token_path` form. Tests: `bunny-sign.spec.ts` (7) + `media-signed.spec.ts` (5) green.

### 5.1 `src/config/env.ts`
Add to the `bunny` block:
```ts
// Token Authentication key for signed CDN URLs (Model C). Secret.
streamTokenKey: optional('BUNNY_STREAM_TOKEN_KEY', ''),
```
Add a `media.mode`:
```ts
// 'proxy' = Model B (stream bytes); 'signed' = Model C (302 to signed Bunny URL).
mode: optional('MEDIA_MODE', 'proxy') as 'proxy' | 'signed',
// Signed-URL TTL (Model C), seconds.
signedUrlTtlSeconds: Number.parseInt(optional('MEDIA_SIGNED_URL_TTL_SECONDS', '7200'), 10),
```

### 5.2 `.env` / `.env.example`
Add `BUNNY_STREAM_TOKEN_KEY`, `MEDIA_MODE`, `MEDIA_SIGNED_URL_TTL_SECONDS`. (The repo blocks
editing `.env` from tooling — the operator adds these by hand.)

### 5.3 `src/modules/media/bunny-sign.util.ts` (new)
`signBunnyUrl(guid: string, opts?: { ttl?: number; path?: 'hls' | 'mp4'; res?: MediaResolution }): string`
— builds the signed CDN URL per §4. HLS → `/{guid}/playlist.m3u8`; MP4 → `/{guid}/play_{res}.mp4`.

### 5.4 `src/modules/media/media-token.util.ts`
**No change.**

### 5.5 `src/modules/media/media.service.ts`
Keep `assertEnrollment` and `fetchUpstream` (Model B still needs `fetchUpstream`). Add a thin
`buildSignedUrl(guid)` that delegates to `bunny-sign.util.ts`.

### 5.6 `src/modules/media/media.controller.ts`
Branch the `stream` handler on `env.media.mode` **after** the token-verify + enrollment gate:
```
… verifyMediaToken + enrollment gate (unchanged) …
if (env.media.mode === 'signed') {
  return res.redirect(302, this.mediaService.buildSignedUrl(payload.guid));
}
// else: existing Model B proxy path (unchanged)
```
Keep the proxy path intact — it is the rollback.

### 5.7 `src/modules/media/media.routes.ts` / `media.module.ts` / `dto/media.dto.ts`
No change (same endpoint, same query DTO; `res` is ignored when signed-HLS is used).

### 5.8 `src/modules/product/product.serializer.ts`
**No change.** `streamUrl` already points at `/api/member/media/stream`.

---

## 6. Cutover sequence

1. Implement §5 with `MEDIA_MODE` defaulting to `proxy` → **deploying causes zero behaviour
   change** (still Model B).
2. Land + deploy. Verify the suite is green and media still streams (Model B).
3. Confirm §2 preconditions. Put `BUNNY_STREAM_TOKEN_KEY` in `.env`.
4. **Enable Token Authentication** on the Bunny library.  ← legacy breaks here unless §2
   box 1 was satisfied.
5. Flip `MEDIA_MODE=signed`, restart backend.
6. Verify (§8).

## 7. Tests (`tests/media.spec.ts` + new `tests/bunny-sign.spec.ts`)

- `bunny-sign.spec.ts` — signing is deterministic for a fixed `(key, path, expires)`;
  URL-safe charset; `expires` in the URL.
- `media.spec.ts` — add a `MEDIA_MODE=signed` block (set the env, re-import): preview token →
  `302` with a `token=`+`expires=` Location; non-preview not enrolled → `403`; non-preview
  enrolled → `302`; bad token → `401`. Keep the existing `proxy`-mode cases.
- Optional live probe (not in CI): a signed URL returns `200` from the real CDN, unsigned
  returns `403`.

## 8. Verification checklist

- [x] `pnpm exec tsc -p tsconfig.json --noEmit` clean.
- [x] `pnpm test` green (both modes covered) — 179/179.
- [x] **Live: signed URL `200`** against `vz-f594ac4d-255.b-cdn.net` (library 666592),
      verified 2026-05-21 via `scripts/probe-bunny-token.ts`. The signing algorithm
      (`bunny-sign.util.ts`) is confirmed correct against the real Bunny CDN.
- [ ] Mobile player follows the `302` and streams from the Bunny edge.
- [ ] Backend egress for media drops to ~0 (metrics).
- [ ] `docs/specs/media-port.md` + `docs/specs/rewrite-progress.md` updated to say media runs Model C.

### Library prerequisite — `BlockNoneReferrer` must be OFF

The Model C library (`666592`) must have **`BlockNoneReferrer = false`**. With it `true`,
every request without a `Referer` header is `403` — and a native mobile player streaming a
signed URL does not send one, so the token never gets a chance. The signed token is the
access control; referrer blocking is redundant and breaks Model C. (`AllowDirectPlay = false`
is fine — it does not block signed direct-CDN access.) Verified: flipping `BlockNoneReferrer`
to `false` turned the signed probe from `403` to `200`.

## 9. Rollback

Instant, no redeploy: set `MEDIA_MODE=proxy` and restart → back to Model B byte proxy.
If Token Authentication itself caused breakage, also disable it in the Bunny dashboard.
Because the Model B proxy code is never removed, rollback is always one env var away.

---

## 10. Open questions to resolve at implementation time

- Does the Bunny Stream Security tab separate *embed* vs *direct-file* token auth? If yes,
  Model C may ship **without** retiring legacy (precondition §2 box 1, option 2).
- HLS vs MP4 as the signed transport — confirm MP4 fallback is still enabled and decide.
- Exact `token_path` directory-token form — confirm from Bunny docs.
- Download flow: a dedicated longer-TTL signed URL, or reuse the streaming TTL.

---

## 11. New-library content migration (REQUIRED before the flip)

Model C content lives in a **new** Bunny Stream library (`666592`), separate from the legacy
library (`157244`). A new library gives every video a **new `guid`** — Bunny `guid`s are
per-video-per-library. The DB `slidesData` JSONB still stores the **old** `157244` guids, so
a signed URL built from them would point at a video that does not exist in `666592`.

### Runbook (scripts)

All scripts read `BUNNY_ACCOUNT_API_KEY` from `.env`. **None delete anything in `157244`** —
the legacy library stays intact as the rollback source.

| Script | Purpose |
|---|---|
| `scan-media-guids.ts` | inventory — every Bunny guid referenced by `slidesData` |
| `migrate-all-media.ts` | the migration — phases `status` / `copy` / `rewrite` |
| `migrate-product-media.ts` | per-product migration (testing / spot fixes) |
| `check-product-media.ts` | print one product's slide guids straight from the DB |
| `copy-bunny-video.ts` | copy a single video (POC tool) |

State files (gitignored, runtime): `scripts/media-guid-map.json` (old→new guid map — the
resumable source of truth), `scripts/media-guids.json` (inventory), `scripts/media-copy-failures.json`.

Steps:

1. **Inventory** — `pnpm exec tsx scripts/scan-media-guids.ts`
2. **Progress** — `pnpm exec tsx scripts/migrate-all-media.ts status`
3. **Copy all videos** (long — ~178 videos, encodes in chunks of 8; resumable):
   `pnpm exec tsx scripts/migrate-all-media.ts copy --apply`
   Re-run until `status` shows `0 to copy` and `media-copy-failures.json` is gone.
4. **Rewrite the DB** — dry-run then apply:
   `pnpm exec tsx scripts/migrate-all-media.ts rewrite` then `… rewrite --apply`
5. **Cutover** — swap env to library `666592` + `MEDIA_MODE=signed` (§6).

Notes:
- Source = the highest MP4 rendition (`720p`→`480p`→`360p`). `/original` is blocked
  (`ExposeOriginals=false` on `157244`) — the copy re-encodes from the rendition.
- Library `666592` must have `BlockNoneReferrer=false` (§8).
- Copy is resumable — `media-guid-map.json` records each video the moment it finishes.
- `copy` and `rewrite` are independent and idempotent — safe to repeat.
- The media module code is library-agnostic (it signs whatever `env.bunny.streamCdnHost` +
  `streamTokenKey` point at), so this migration is a separate workstream from the module.
