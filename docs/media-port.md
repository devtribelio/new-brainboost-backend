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
`docs/legacy-providers.md` and `docs/api-fe.md` §2.8:

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
- **TX.1** admin-side upload to Bunny (see `docs/legacy-providers.md`).
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
  **Ready-to-execute migration plan: `docs/media-model-c-migration.md`.**

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

## 9. Audio as ONE file from our own storage (opt-in per asset, 2026-09-18)

**Why.** Offline downloads on Android fail on Xiaomi/POCO: one HLS lesson is
780–920 tiny `background_downloader` (WorkManager) jobs that MIUI/HyperOS stops
(`canceled`), and the Dart loop that enqueues the next batch is frozen when the
app is backgrounded. Bunny Stream has no audio-only rendition (§8), so every
"audio" download also carries a still-image video track.

**What.** For a guid with an **active** row in `media_audio_sources`,
`GET /media/hls` answers with a URL on this backend,
`GET /media/audio-playlist?t=<audio-playlist token>`, which renders an HLS media
playlist whose only segment is the whole lesson as `.aac` behind a short-lived
signed URL. The app already in the stores downloads "every segment in the
playlist" and keeps the extension, so it fetches ONE file with zero client
change; iOS hands the playlist to `AVAssetDownloadURLSession` as before.
Video assets and every guid without a row keep the Bunny path byte-for-byte.

**Rules.**
- The playlist branch is checked **before** the `MEDIA_MODE=signed` guard: it
  never touches the Bunny library, so the Token-Auth requirement does not apply.
- `/media/audio-playlist` takes **no bearer** (native downloaders send none) and
  accepts **only** an audio-playlist token (`k:'a'`), minted by `/media/hls`
  AFTER its enrollment gate with a TTL equal to the segment URL TTL.
  `verifyMediaToken` rejects `k:'a'` so the playlist token cannot be spent on
  `/stream`, `/download` or `/hls`.
- The playlist is rendered per request with a fresh signed segment URL and sent
  `Cache-Control: no-store`. Today the signer is an S3 presigned GET
  (`S3StorageService.getPresignedGetUrl`); the CloudFront signer replaces that
  one call when the `/private/audio/*` CloudFront behaviour ships.
- Rollback per asset = `UPDATE media_audio_sources SET is_active=false` — the
  next `/hls` answer is Bunny again; a playlist token already issued 404s.
- Segment format is ADTS `.aac`: a single segment with no `EXT-X-MAP` is only
  valid for an elementary stream. fMP4 + `EXT-X-MAP` is the fallback if a
  device rejects ADTS (the app parser supports both).

**Moving one asset by hand (develop / first prod canary).**
```bash
# 1. audio track out of the cheapest Bunny rendition, no re-encode
ffmpeg -i "<signed 360p mp4 url>" -vn -c:a copy -f adts /tmp/<guid>.aac
ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/<guid>.aac   # seconds
shasum -a 256 /tmp/<guid>.aac
# 2. under private/ — the prefix the bucket policy never opens and the storage service treats as presign-only
aws s3 cp /tmp/<guid>.aac s3://<bucket>/private/audio/<guid>/1.aac --content-type audio/aac
# 3. row (inactive first, then flip)
INSERT INTO media_audio_sources (guid, audio_key, duration_sec, bytes, sha256, encoded_at, is_active)
VALUES ('<guid>', 'private/audio/<guid>/1.aac', <dur>, <bytes>, '<sha>', now(), false);
UPDATE media_audio_sources SET is_active = true WHERE guid = '<guid>';
```
Verify with the store build of the app pointed at that environment, on the
POCO that failed: download with the screen off, three times.

**Spec / decisions:** `docs/prd-audio-single-file-cdn.md`.

**Which lesson is this row?** `media_audio_sources.lesson_id` is an informational FK
(nullable, SET NULL, migration `20260918140000`) filled from `slides_data` at insert time;
the runtime lookup stays by `guid`. The view `media_audio_source_lessons` (migration
`20260918130000`) recomputes the relation from `slides_data` and exposes `stored_matches`
so a stale `lesson_id` is visible. No hard dependency on the FK by design (the relation lives inside
`slides_data` JSON and one asset may serve several lessons), so the view resolves
it at read time:
```sql
SELECT product_title, lesson_name, lesson_duration_sec, source_duration_sec, is_active, audio_key
FROM media_audio_source_lessons ORDER BY product_title, lesson_name;
-- a source row with lesson_id NULL is an orphan: no lesson references that guid
```

**Split into a handful of parts (default 8) — migration `20260918150000`.** One file
works but the store app draws progress as *segments done / total* (a single segment
sits at 0 % then jumps to 100 %) and schedules segment batches from a Dart loop that
MIUI freezes in the background. `media_audio_sources.segments`
(`[{key,durationSec,bytes}]`, play order) lists MPEG-TS parts cut by ffmpeg's hls muxer
without re-encoding; the playlist renders one line per part, each with its own signed
URL. **Keep it ≤ the app's batch size** — decided 2026-09-18 at **12 parts** (= the 3.3.3
batch); the 3.4.0 branch had lowered its batch to 8, so 3.4.0 must ship with a batch
≥ 16 (asked of the mobile team), never 8. Was ≤ 8 (one batch on both shipped sizes: 12 in 3.3.3, 8 in
3.4.0), so there is never a second batch to stall. `segments = NULL` keeps the
single-file behaviour. `scripts/media-encode-audio.sh --parts N` produces both.

### 9.x Segment URLs through CloudFront (signed), S3 presign as the fallback

`MediaService.signObjectUrl` picks the signer per key. With `MEDIA_CDN_HOST`,
`MEDIA_CDN_KEY_PAIR_ID` and `MEDIA_CDN_PRIVATE_KEY` all set, a key under
`private/audio/` is signed as a **CloudFront canned-policy URL**
(`https://<host>/<key>?Expires=&Key-Pair-Id=&Signature=`, `@aws-sdk/cloudfront-signer`);
anything else — any of the three empty, or a key outside that prefix — stays an S3
presigned GET. The prefix check is not tidiness: only the `private/audio/*` behavior
trusts the key group, so the CDN would answer 403 for a key elsewhere while S3 still
serves it. Why the CDN at all when the per-GB price is the same as S3 in this region:
1 TB/month free tier (S3: 100 GB), one origin fetch per part instead of one S3 GET per
download, HEAD works (an S3 presigned GET is GET-only, HEAD → 403), and the bytes
come from the Jakarta/Singapore edge.

Infra is `infra/cdk/lib/bb-media-cdn-stack.ts`: one distribution per env in front of
the **existing** bucket (OAC; the bucket stays closed), default behavior = today's
`public/*` (CachingOptimized, redirect-to-https, HTTP/2+3, IPv6 — copied from
cdn.brainboost.id), plus `private/audio/*` with a trusted key group. The public key
lives in the repo (`infra/cdk/cdn-keys/<env>.public.pem`); the private key in Secrets
Manager `bb/<env>/cdn-signing-key` and reaches the app as `MEDIA_CDN_PRIVATE_KEY`
(raw PEM or base64 of it — `env.ts` accepts both, because a multi-line value does not
survive every .env loader). Two things are outside CDK on purpose: the ACM cert
(must be us-east-1; DNS is Cloudflare, so validation is a manual CNAME, and CDK would
block the deploy waiting for it) and the bucket policy (the bucket is imported —
CDK's `BucketPolicy` would replace the public-read statement; merge the stack's
`BucketPolicyStatement` output in by hand). Cloudflare records must be **DNS-only**
(grey cloud): proxied, the cert validation fails and Cloudflare sits in front of
CloudFront. Staging = `cdn-staging.brainboostos.com` (bucket `brainboost-staging`,
ap-southeast-1); prod = the existing `cdn.brainboost.id` distribution, to be
**imported** into the same stack (it was created by hand), never recreated.

Deploy: `cdk deploy BbMediaCdnStagingStack -c mediaCdnEnv=staging -c mediaCdnCertificateArn=<arn>`.

### 9.y Migrating an asset from the backoffice (queue + cron job)

The backoffice page **Learning → Audio Storage** lists every audio lesson with where
it is served from (Bunny / S3) and offers three actions. It never touches ffmpeg,
Bunny or S3 — same split as payout approval:

| Button | What the backoffice writes | Who does the work |
|---|---|---|
| Migrasi ke S3 | `INSERT media_audio_migration_jobs (guid, lesson_id, parts, requested_by)` | `migrateAudioToStorage` on the 5-minute lane (`bb-cron-disburse` / CDK `CronDisburse`) |
| Kembali ke Bunny | `UPDATE media_audio_sources SET is_active = false` | nobody — `/media/hls` re-reads the row per request |
| Aktifkan S3 | `UPDATE … SET is_active = true` | nobody |

The job (`apps/mobile-api/src/modules/media/audio-migration.job.ts`) per request:
download the Bunny MP4 (360p first — audio is byte-identical at 360p/480p; signed URL
in `signed` mode, Referer in `proxy`), copy the AAC track out **without re-encoding**,
cut into ≤ `parts` MPEG-TS files (`segmentSeconds` = ceil, so ffmpeg can only produce
≤ `parts`), upload under the first **empty** `private/audio/<guid>/<version>/` (those
keys are served `immutable`; a reused key would leave CDN and bucket disagreeing),
range-GET the first and last part, then upsert `media_audio_sources` **active**. A
failure is terminal for that job (`FAILED` + message; the button makes a new one);
only a job that *died* (PROCESSING > 30 min) is retried, up to 3 attempts. A partial
unique index allows one open job per guid, so a double click is a 409, not two encodes.
It stops claiming work after 3 minutes because PM2's `cron_restart` kills a process
still running at the next tick. **Needs `ffmpeg`/`ffprobe` on the host**: in the image
via the Dockerfile; on the staging VPS `sudo apt-get install -y ffmpeg`.
