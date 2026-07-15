# Media Port — BunnyCDN Stream Proxy

How course audio/video reaches the mobile client, and why the `media` module exists.

---

## 1. Problem

Course audio + video are hosted on BunnyCDN. Legacy mobile read `videoLibraryId` + `guid`
straight out of the course-detail response and played the asset by loading Bunny's iframe
embed in a WebView. That exposes the Bunny identifiers (and the account) to the client.

**Goal of this module:** the raw Bunny `guid` / `library_id` must never reach the frontend.

---

## 2. Bunny audit (probed 2026-05-21)

Findings from probing the live Bunny endpoints — these correct earlier assumptions in
`docs/specs/legacy-providers.md` and `docs/specs/api-fe.md` §2.8:

- **One Stream library, not Stream + Storage.** Audio and video are both objects in a
  single Bunny **Stream** library — id `157244`, CDN host `vz-5439ef3e-878.b-cdn.net`.
  "Audio" lessons are just Stream video objects (they carry `width`/`height`/`x264`).
  Legacy `vz-5439ef3e-878` is that library's CDN hostname, **not** a storage zone.
- **Protection is referrer-gating only.** A request to `vz-5439ef3e-878.b-cdn.net/{guid}/…`
  with no `Referer` header returns `403`; with **any** `Referer` value it returns `200`.
  That is hotlink protection — **not** token authentication, **not** access control.
  Token Authentication is off; knowing `library_id` + `guid` is enough to fetch the asset.
- `tribelio-zone.b-cdn.net` is a separate Storage pull zone (token auth off) — not course media.
- MP4 fallback is enabled (`hasMP4Fallback: true`), renditions `360p,480p,720p` — so each
  asset is fetchable as a single MP4 file (`/{guid}/play_{res}.mp4`), no HLS handling needed.

### Slide shapes (`Lesson.slidesData` JSONB)

```jsonc
// AudioTemplate — structured object
{ "type": "AudioTemplate", "data": { "platform": "bunnynet",
  "audio": { "guid": "...", "videoLibraryId": "157244", /* + many Bunny fields */ } } }

// VideoTemplate — guid embedded in an HTML iframe blob, NO structured object
{ "type": "VideoTemplate", "data": { "platform": "bunnynet",
  "url": "<div…><iframe src=\"https://iframe.mediadelivery.net/embed/157244/{guid}?…\"></iframe></div>" } }
```

---

## 3. Design — Model B (backend proxy)

Considered three models:

| Model | guid hidden from FE? | Backend bandwidth | Notes |
|---|---|---|---|
| A — direct URLs | no | none | current behaviour; identifiers exposed |
| C — signed URLs | **no** — token auth signs the URL but `guid` stays in the path | none | also needs Token Auth enabled |
| **B — proxy** | **yes** | 2× (every byte transits backend) | only model that truly hides `guid` |

Hiding the `guid` is the explicit requirement, so **Model B** is the only fit. The bandwidth
cost is accepted. Single-file MP4 proxying keeps it simple (no HLS playlist rewriting).

---

## 4. Implementation

```
src/modules/media/
  media-token.util.ts   # AES-256-GCM encrypt/decrypt of the opaque token
  media.service.ts      # enrollment check + Bunny upstream fetch
  media.controller.ts   # stream handler — gate, range relay, pipe
  media.routes.ts       # GET /media/stream  (optionalAuthGuard)
  media.module.ts       # AppModule (prefix /member)
  dto/media.dto.ts      # query DTO + MEDIA_RESOLUTIONS
```

- **Token** — `signMediaToken({ guid, courseId, isPreview })` encrypts an AES-256-GCM
  envelope (`iv | tag | ciphertext`, base64url) with `MEDIA_TOKEN_SECRET`. Encryption (not
  signing) keeps the `guid` itself secret; the GCM tag makes it tamper-evident. Carries an
  `exp` (`MEDIA_TOKEN_TTL_SECONDS`, default 6 h).
- **Serializer** — `product.serializer.ts` mints a token per audio/video slide and emits
  `data.streamUrl` instead of `guid`/`videoLibraryId`/iframe-HTML, in both `slidesData`
  (raw passthrough, now scrubbed) and `dataContent`. `parseBunnyEmbed()` extracts the guid
  from the VideoTemplate iframe blob.
- **Endpoint** — `GET|HEAD /api/member/media/stream?t={token}&res={360p|480p|720p}`.
  `optionalAuthGuard`: preview media streams anonymously; non-preview requires a member
  token + a matching `CourseEnrollment` row. Returns binary `video/mp4`, not the JSON
  envelope. HTTP `Range` is forwarded both ways (seek + resumable download).

### Flow

```
1. GET /api/member/product/course/detail?code=…
     → serializer emits, per audio/video slide: data.streamUrl = /api/member/media/stream?t={token}

2. GET /api/member/media/stream?t={token}   [+ Bearer]   [+ Range]
     → verifyMediaToken(t) → { guid, courseId, isPreview }
     → if !isPreview: require member + assertEnrollment(courseId, memberId)  (else 401/403)
     → fetch https://vz-5439ef3e-878.b-cdn.net/{guid}/play_{res}.mp4   (Referer header, Range)
     → relay 200/206 + content-range/accept-ranges, pipe bytes
```

---

## 5. Config (`.env`)

| Var | Purpose |
|---|---|
| `BUNNY_STREAM_CDN_HOST` | Stream CDN host (`vz-5439ef3e-878.b-cdn.net`) |
| `BUNNY_STREAM_LIBRARY_ID` | library id `157244` (management API only) |
| `BUNNY_STREAM_API_KEY` | Stream management API key (metadata; optional) |
| `BUNNY_REFERER` | `Referer` sent on CDN fetch — required (pull zone blocks empty referer) |
| `MEDIA_TOKEN_SECRET` | AES key source — **required in production** |
| `MEDIA_TOKEN_TTL_SECONDS` | token lifetime (default `21600`) |
| `MEDIA_DEFAULT_RESOLUTION` | rendition when `?res=` omitted (default `720p`) |

---

## 6. Known gaps / follow-ups

- **Mobile must drop the WebView/iframe player** and use a native player pointed at
  `streamUrl`. Model B is inert until the mobile client switches — coordinate the cutover.
- **`VideoTemplate` real duration** is not in the JSONB (`duration` is a `"60"` placeholder).
  Fetch from the Bunny metadata API if accurate length is needed.
- **Bandwidth** — every media byte transits the backend. For volume, consider a reverse
  proxy in front, or enable Bunny Token Authentication (`bunnynetAPIKey` → pull zone
  `ZoneSecurityKey`) and move to signed URLs (Model C) — note that exposes the `guid`.
- **TX.1** admin-side upload to Bunny (see `docs/specs/legacy-providers.md`).
- **Integration tests** (`tests/media.spec.ts`, 10 cases) pass against a host Postgres on
  `localhost:5433`; full suite 168/168 green.

---

## 7. Limitations & trade-offs

Model B (backend proxy) was chosen because hiding the Bunny `guid`/`library_id` is a hard
requirement and no other model achieves it. The cost of that choice:

### Performance & cost
- **2× bandwidth** — every media byte transits the backend (Bunny → backend → client).
  Server egress doubles; for video this is the dominant cost.
- **Higher latency** — an extra hop. Bunny's global edge is bypassed; clients far from the
  backend see slower start and more buffering.
- **Backend is a streaming bottleneck** — each viewer holds a backend connection + socket
  for the whole playback (course audio runs ~60 min). Concurrency scales with viewers, not
  CPU — more instances are needed purely for bandwidth.
- **No edge caching** — Bunny caches at the edge; proxied requests re-fetch from Bunny every
  time unless a caching layer is added.
- **Double cost** — Bunny bandwidth + backend egress, and host egress is usually pricier per
  GB than CDN.

### Resilience
- **Single point of failure** — backend down = all media down. Direct Bunny would keep media
  on the CDN's SLA.
- **Token expiry mid-transfer** — a long offline download on a slow link can outlive the 6 h
  token TTL and `401` partway through.

### Lost features
- **No adaptive bitrate** — single-file MP4 means a fixed resolution per request; no quality
  switching on a variable mobile network. (Negligible for audio, a UX downgrade for video.)
- **Not DRM** — once bytes reach the client the plain MP4 can be captured. The proxy hides
  the `guid` and gates access at fetch time; it does not protect the file itself.

### Security & ops
- **Scraping** — the endpoint is easy to script; one enrolled account can pull the whole
  library. No per-member rate limit is implemented yet.
- **Range/seek correctness** — the backend now owns Range forwarding + `206`/`416`/`HEAD`
  relay; subtle bugs are possible (one stream-error process crash was already found + fixed).
- **Bunny coupling** — a change to Bunny's URL format or referrer behaviour breaks the proxy.
- **Operational burden** — streaming monitoring, logs, stream-leak and abort handling are now
  the backend's responsibility.
- **Mobile rework** — the client must drop the WebView/iframe player for a native player.

### Mitigations
- Put a reverse proxy (nginx) or a CDN in front of the media endpoint to recover caching /
  edge / bandwidth.
- Add a per-member rate limit + audit log against scraping.
- Use a longer token TTL for the download path.
- If "hide the `guid`" is ever relaxed, switch to **Model C** (signed URLs — enable Token
  Authentication on the pull zone via the account API). That removes the bandwidth, latency
  and SPOF costs, at the price of exposing the `guid` in the URL.
  **Ready-to-execute migration plan: `docs/specs/media-model-c-migration.md`.**
