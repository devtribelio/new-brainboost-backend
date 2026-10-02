# Tribe post moderation (AI "kurasi")

Image posts by members are checked by a vision model before they appear in the
tribe. Ops define what to filter (categories) and which provider to use from the
backoffice; this repo holds the check, the state machine and the safety-net job.

Code: `packages/domain/src/moderation/post-moderation.ts`,
`packages/domain/src/jobs/moderate-posts.ts`, hook in
`packages/domain/src/post/post.service.ts::create`.
Tests: `apps/mobile-api/tests/post-moderation.spec.ts`.
Migration: `20261002120000_post_moderation`.

## 1. When moderation is ON

All of these, read per post (settings are cached ~30 s per process):

| `app_settings` key | Seed | Meaning |
|---|---|---|
| `moderation.enabled` | `false` | master switch |
| `moderation.baseUrl` | `''` | OpenAI-compatible base URL, **without** `/chat/completions` (e.g. `https://api.openai.com/v1`) |
| `moderation.model` | `''` | vision-capable model id |
| `moderation.apiKey` | `''` | bearer key (in the DB by product decision; never logged) |

…plus **at least one** `moderation_categories` row with `is_active = true`.
Anything less = OFF: no `post_moderations` row is written, nothing is held, and
`PostService.create` behaves exactly as it did before this feature.

Scope: posts with a non-empty `imageUrls`. Text-only posts publish immediately.
`isAdminPost` is never set by the member create endpoint (it is a backoffice
flag), so every post on that path is a member post.

## 2. DB contract (shared with backoffice-bb)

- `posts.publish_status` gains `IN_REVIEW` (held) and `REJECTED`. Neither is in
  `PUBLISHED_STATUSES`, so every published gate hides them.
- `moderation_categories`: `id` uuid pk, `name` text unique, `description` text
  (given to the model verbatim), `is_active` bool default true, `created_at`,
  `updated_at`.
- `post_moderations`: `id` uuid pk, `post_id` uuid **unique** (no FK — audit row),
  `status` `PENDING | APPROVED | REJECTED | ERROR`, `category_name`, `reason`,
  `decided_by` default `'AI'` (`AI | ADMIN`), `model`, `attempts` int default 0,
  `last_error`, `checked_at`, `created_at`, `updated_at`. Index on `status`.

Plain-SQL writers: `id` has **no DB default** (`uuid(7)` is Prisma-Client-side) —
supply it. `created_at` and `updated_at` both default to `CURRENT_TIMESTAMP`, but
`updated_at` is not auto-bumped on UPDATE — set it.

**Admin override:** set `post_moderations.decided_by = 'ADMIN'` (+ `status`) and
`posts.publish_status` together. A row with `decided_by = 'ADMIN'` is final: the
inline check and the job never read past it, and a check already in flight
cannot overwrite it (its write is a conditional `UPDATE … WHERE decided_by <>
'ADMIN' AND status/attempts unchanged`). An admin approving a held post by SQL
does **not** fan out the "new post" notification — that only happens in-app.

## 3. Flow

```
create (image post, moderation ON)
  └─ tx: posts(IN_REVIEW) + post_moderations(PENDING)      → 201, publishStatus "IN_REVIEW"
       └─ setImmediate → moderatePost(postId)
            clean      → post PUBLISHED, row APPROVED, emit post.published (topic fan-out)
            violation  → post REJECTED,  row REJECTED (category_name, reason), notify AUTHOR only
            error      → post PUBLISHED, row ERROR, attempts+1, last_error, emit post.published
```

- **`post.published` is not emitted while a post is held** — it is emitted when
  the post becomes visible. A rejected post never notifies subscribers.
- **Fail-open** (product decision): non-2xx, timeout (`MODERATION_TIMEOUT_MS` =
  20 s), an unreadable reply, or moderation being switched off while the post
  waited — all publish the post. A provider outage never stops the tribe.
- **Job `moderatePosts`** (5-minute lane, before `migrateAudioToStorage`;
  registered in `jobs-runner.ts`, `ecosystem.config.js`, `bb-ecs-stack.ts`):
  - `PENDING` rows older than 2 min (API process died before the inline check);
  - `ERROR` rows with `attempts < 3` → re-check. Violation → post flips to
    `REJECTED` + author notified; clean → row `APPROVED`. After 3 failed checks
    the row stays `ERROR` and the post stays published.
  - 25 rows per tick, 5 at a time. The job awaits the topic fan-out directly
    (`notifyTopicSubscribers`) because the cron process has no event listeners.

### The provider call

`POST {baseUrl}/chat/completions`, `Authorization: Bearer {apiKey}`. System
prompt = the active categories (`name: description`) + "answer with one JSON
object `{"violation": boolean, "category": string|null, "reason": string}`".
User content = the post text through `toPlainText` + one `image_url` part per
image. Images go as **URLs**: post images are permanent public CDN URLs
(`public/posts/…`, docs/upload-s3-port.md), so the provider fetches them.
No provider-specific JSON mode, no `temperature` (some models reject it).

`parseVerdict` takes the first balanced `{…}` in the reply (code fences and
surrounding prose are fine) and requires `violation` to be a real boolean.
Anything else is an ERROR — an unreadable reply is never an approval.
`category_name` is stored only when it matches an active category name
(case-insensitive); an invented one is stored as NULL.

## 4. What members see

- **Author, on create:** normal `201` with the usual post body;
  `publishStatus` is `"IN_REVIEW"` instead of `"PUBLISHED"`. No shape change.
- **Author, afterwards:** `GET /post/detail` of their own post works in every
  state (and shows `publishStatus`). `GET /post/list` — including `filter=mine`
  — lists published posts only, so a held or rejected post is **not** in the
  author's feed.
- **Everyone else:** not in any list, not in topic/network post counts;
  `GET /post/detail` → `403 POST_NOT_PUBLISHED`; like → `403 POST_NOT_PUBLISHED`;
  comment → `400 COMMENT_ON_UNPUBLISHED_POST`; comment list → empty.
- **Rejection notice** (author only): type `postRejected`, title "Postinganmu
  tidak dapat ditampilkan", body "Postingan ini melanggar aturan komunitas, jadi
  tidak kami tampilkan ke anggota lain.", payload `{ refTable: 'post', refId }`.
  The category is deliberately not named. Not in `PUSH_LIMIT_EXEMPT`.
- A rejected post does not trip the 10-minute duplicate guard, so the author can
  post the same text again with a different image.

No client release is required. Nice-to-have on the app: a "sedang ditinjau" /
"ditolak" badge keyed on `publishStatus`, and keeping the author's own held post
visible locally after create.

## 5. Logs

Flat pino lines: `moderation.approved`, `moderation.rejected`,
`moderation.error` (`postId`, `authorId`, `model`, `attempts`, + `error` /
`category` / `released`). The API key is never logged or stored in `last_error`.

## 6. Known gaps

- **No post-edit path exists** (`POST /post/create` only creates), so "re-check
  when images change" has nothing to hook. Whoever adds editing must hold the
  post again.
- **Fail-open then rejected:** subscribers were already notified; their
  notification now opens a `403`. Comments on it are hidden, counters untouched.
- **Only images + text are sent.** `videoUrl` / `embedUrl` are not checked, and a
  video-only post is not moderated.
- **Image URLs are client-supplied strings.** A URL the provider cannot fetch is
  a provider error → fail-open. There is no check that the URL is on our CDN.
- **Push from the cron process:** rows are written, but FCM dispatch is
  fire-and-forget (`setImmediate`) and the jobs-runner exits right after — a push
  triggered by the job may be cut off. Same pre-existing limitation as other jobs.
- **Give-up is quiet:** a row stuck at `ERROR`/3 attempts is only visible in the
  backoffice list and the `moderation.error` log; no alert.
- **Legacy drafts:** the like and comment-list gates now also apply to any
  pre-existing non-published post (previously likeable). Intentional.
- Settings cache (30 s) means a switch flip takes up to 30 s per process.
- Cost/latency: one model call per image post, no per-member rate limit beyond
  the existing duplicate guard.
