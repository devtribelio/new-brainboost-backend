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
  asset is fetchable as a single MP4 file (`/{guid}/play_{res}.mp4`), no HLS handling needed
  for Model B. **HLS is not optional and never was**: Bunny Stream transcodes every upload to
  an HLS ABR ladder, and MP4 is the *additional* output that `hasMP4Fallback` switches on.
  `/{guid}/playlist.m3u8` has always been live alongside the MP4s — see §8 for what is
  actually in it.

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
  Recovered by the HLS path (§8) — `GET /media/hls` hands the client the ABR ladder.
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

---

## 8. HLS audit (probed 2026-08-11) — audio is stored as video

Probed live against library `157244` (`vz-5439ef3e-878.b-cdn.net`) with a `Referer` header,
using guids from `scripts/media-guids.json`. Everything below is measured, not inferred.

### There is no audio-only variant

`playlist.m3u8` for an **audio** lesson — identical across the three guids probed:

```
#EXT-X-STREAM-INF:BANDWIDTH=1416800,CODECS="avc1.42c016,mp4a.40.2",RESOLUTION=640x360
#EXT-X-STREAM-INF:BANDWIDTH=2373800,CODECS="avc1.42c016,mp4a.40.2",RESOLUTION=854x480
#EXT-X-STREAM-INF:BANDWIDTH=4677200,CODECS="avc1.42c01f,mp4a.40.2",RESOLUTION=1280x720
```

Every variant carries `avc1` (H.264). There is **no** `#EXT-X-MEDIA:TYPE=AUDIO` rendition —
Bunny Stream has no audio-only mode, so an audio lesson is a video of a static image.
This is the majority of the library: `scripts/media-guids.json` counts **108 audio vs 70
video** out of 178 assets.

### Measured bitrates (ffprobe, 40 s sample)

| Rendition | Audio | Video (HLS) | Video (MP4) |
|---|---|---|---|
| 360p | **134 kbps** | 64 kbps | 1.9 kbps |
| 480p | **134 kbps** | 88 kbps | 71 kbps |
| 720p | **202 kbps** | 157 kbps | 134 kbps |

All AAC-LC, 48 kHz, stereo.

- **360p and 480p carry byte-identical audio** — the extracted audio track is the same size
  from both. Dropping 480p → 360p costs nothing audible, or inaudible.
- **720p bumps audio to ~202 kbps.** Bunny's top rendition raises the audio profile. For
  spoken-word course material AAC-LC 134 kbps stereo is already past transparent, so that
  extra 68 kbps is bytes with no benefit.

### The HLS keyframe penalty

For a 61-minute audio lesson (920 segments, `#EXT-X-TARGETDURATION:4`):

| Format | Size |
|---|---|
| MP4 360p | 60 MB |
| MP4 480p | 90 MB |
| MP4 720p | 147 MB |
| HLS 360p | ~87 MB |
| HLS 720p | ~157 MB |

HLS 360p is **~45 % larger than MP4 360p** — and the cause is not the video track existing
(it exists in the MP4 too), it is the **keyframe every 4 s**. MP4 360p encodes the static
image at 1.9 kbps with a long GOP; HLS must restart each segment, re-encoding that same
still 920 times, which lands at 64 kbps. Roughly 29 MB of a 91 MB asset is that redundancy.

### Consequence — pin 360p for offline

HLS has no server-side default rendition; the downloader picks. Left alone **iOS takes the
top variant**, i.e. 157 MB for a one-hour audio lesson. The client must pin 360p:

- iOS — `AVAssetDownloadTaskMinimumRequiredMediaBitrateKey`
- Android — `DownloadHelper.getTrackSelections()`

Trap when setting that threshold: the `BANDWIDTH` Bunny advertises (1.4 / 2.4 / 4.7 Mbps) is
peak, roughly 7× the real average (198 / 222 / 359 kbps). The value is compared against the
**advertised** number, so "set 2 Mbps for good quality" silently selects 480p.

Whether this is a regression or an improvement depends on what the app requests today from
`/media/download`: `res=360p` → HLS costs +45 %; no `res` at all → the default is
`MEDIA_DEFAULT_RESOLUTION=720p` = 147 MB today, so HLS 360p is a 41 % saving.
`MEDIA_DEFAULT_RESOLUTION` is deliberately **not** lowered to `360p` globally — 70 of the 178
assets are real video, where 360p is a genuine quality drop.

### `GET /api/member/media/hls`

Serves both online playback and native offline download; the only difference is TTL.

```jsonc
// GET /api/member/media/hls?t=<opaque media token>&download=true
{ "success": true,
  "data": {
    "url": "https://{host}/bcdn_token=HS256-…&token_path=…&expires=…/{guid}/playlist.m3u8",
    "expiresAt": 1786000000,   // unix; the exact value signed into the URL
    "guid": "…"
  } }
```

- **JSON, not a `302`** (which is what `/media/stream` and `/media/download` return): the
  native downloaders manage the fetch themselves and need the URL as a value.
- **Directory token** — scoped `/{guid}/`, so every `.ts` segment inherits it. One URL covers
  the whole asset. Treat the URL as opaque; do not parse or rebuild its query.
- **No `res` parameter** — rendition is the client's choice (see above).
- `download=true` → `MEDIA_DOWNLOAD_TTL_SECONDS` (24 h) instead of
  `MEDIA_SIGNED_URL_TTL_SECONDS` (2 h). The streaming TTL is deliberately not raised: the URL
  works without auth for its whole lifetime, and a stream has no reason to be shareable for a
  day.
- `expiresAt` is returned because **an in-flight download cannot have its URL swapped** —
  neither `AVAssetDownloadTask` nor ExoPlayer's `DownloadRequest` allows it. A token expiring
  mid-download means cancel and restart, so the app needs the deadline up front. The 24 h TTL
  is what makes that a non-event, not a retry path.
- **404 `MEDIA_HLS_UNAVAILABLE` while `MEDIA_MODE=proxy`.** Signed HLS only works against the
  Token-Auth library (Model C, `666592`). The `proxy`-mode library has token auth off and
  blocks empty referrers — and a native player sends no `Referer`, so the URL would `403` on
  the one client that matters. Failing up front separates "not deployed yet" from
  "access denied".
- Same gating as `/media/download`: `optionalAuthGuard` + enrollment for non-preview, and
  `mediaDownloadRateLimiter` — one signed URL exposes the entire asset, so it is the bigger
  bulk-scrape surface, not the smaller one.

### Not covered

- **Still not DRM.** Downloaded segments sit unencrypted in the app sandbox; a rooted or
  jailbroken device can extract them. Versus a plaintext MP4 this is chunking, not locking.
  Real protection is MediaCage Enterprise (Widevine + FairPlay), $99/mo + license fees.
- **No file export.** A downloaded HLS asset is an OS-managed bundle (iOS `.movpkg`, Android
  ExoPlayer cache), not a file that can be shared or opened elsewhere. If a "save to device"
  feature exists, `/media/download` (MP4) must stay permanently, not just through transition.
- **Re-encoding the audio assets** as low-bitrate video with a long GOP would remove the
  keyframe penalty, but Bunny re-encodes on upload — untested whether the ladder can be
  configured per-library to avoid it.
