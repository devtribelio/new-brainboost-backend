# Media — Model C Migration Plan (signed-URL)

> **Status:** PLANNED — not yet implemented. Backend currently runs **Model B** (byte
> proxy). This document is the ready-to-execute plan for switching to **Model C**
> (backend signs Bunny URLs, client streams direct from the edge).

## 0. How to use this document

When the preconditions in **§2** are met, the implementation can be run directly:
"read `docs/media-model-c-migration.md` and implement". Steps §5–§7 are file-by-file and
ordered. Do **not** start until every box in §2 is ticked — Model C without Token
Authentication enabled is just Model A (no access control).

Background context: `docs/media-port.md` (the Model B implementation + the Bunny audit) and
`docs/legacy-providers.md` (BunnyCDN entry).

---

## 1. Why Model C

Model B proxies every media byte through the backend — see `docs/media-port.md` §7 for the
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
- [ ] **Transport decided** — signed **HLS** (`playlist.m3u8`, adaptive bitrate, recommended)
      vs signed **MP4** (`play_{res}.mp4`, single file). HLS is preferred under Model C since
      there is no proxy to complicate it.

If the first box cannot be satisfied, **stay on Model B** — do not proceed.

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

- [ ] `pnpm exec tsc -p tsconfig.json --noEmit` clean.
- [ ] `pnpm test` green (both modes covered).
- [ ] Live: signed URL `200`, unsigned `403` against `vz-5439ef3e-878.b-cdn.net`.
- [ ] Mobile player follows the `302` and streams from the Bunny edge.
- [ ] Backend egress for media drops to ~0 (metrics).
- [ ] `docs/media-port.md` + `docs/rewrite-progress.md` updated to say media runs Model C.

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
