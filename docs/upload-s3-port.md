# Upload → S3 Port

Status: **implemented** (mobile-api `upload` module). Replaces the old local-disk
multer + `/static/temporary` static serving.

## Decision summary

- **Backend:** AWS S3 for dev **and** prod (no MinIO). The storage layer is the
  S3 API, so swapping in MinIO / Cloudflare R2 later is purely `S3_ENDPOINT` +
  `S3_FORCE_PATH_STYLE` — no code change.
- **Access model: hybrid by key prefix.**
  - `public/*` → public-read via a **bucket policy on the `public/*` prefix**
    (not per-object ACL, so it works with "Bucket owner enforced" / ACLs off).
    URLs are permanent + CDN-cacheable. Used for avatars, covers, post images.
  - `private/*` → no public access; reads go through a short-lived presigned
    GET URL minted per request. Reserved for future sensitive files (report
    attachments, payment proofs, KYC). The storage service already supports it
    (`getPresignedGetUrl` / `urlForKey`); no endpoint wired yet.
- **Image processing (sharp):** every uploaded image is re-encoded to **webp**,
  downscaled so the longest side ≤ `S3_IMAGE_MAX_DIMENSION` (no upscale), and
  EXIF/metadata stripped (drops GPS + neutralises polyglot payloads).

## Object key layout

The upload endpoint takes an optional `?kind=` query param that selects the
folder. Owner segment is always the uploading member's id (`req.user.id`) — at
upload time a post/comment id does not exist yet (2-step flow).

```
public/<folder>/<userId>/<uuid>.webp
```

`kind` → folder + per-kind sizing (`UPLOAD_KINDS` in `upload.service.ts`).
Each kind sets its own `maxDimension` (longest side, px); webp quality falls
back to env unless a kind overrides it:

| `kind`            | folder       | max px | key example |
|-------------------|--------------|--------|-------------|
| `avatar`          | `avatars`    | 512    | `public/avatars/<userId>/<uuid>.webp` |
| `cover`           | `covers`     | 1280   | `public/covers/<userId>/<uuid>.webp` |
| `post`            | `posts`      | 1440   | `public/posts/<userId>/<uuid>.webp` |
| `comment`         | `comments`   | 1024   | `public/comments/<userId>/<uuid>.webp` |
| `network`         | `networks`   | 512    | `public/networks/<userId>/<uuid>.webp` |
| `general` (default) | `uploads`  | 1024   | `public/uploads/<userId>/<uuid>.webp` |

`S3_IMAGE_MAX_DIMENSION` (env, default 1024) is the fallback used by direct
`ImageProcessor.process()` calls; the upload endpoint always passes a per-kind value.

Invalid `kind` → 400 (`validateDto(UploadQueryDto, 'query')`, `@IsIn`).
`<uuid>` is `crypto.randomUUID()` (uniqueness only; sortability not needed).

Future private prefixes (not yet wired): `private/reports/<reportId>/`,
`private/payments/<userId>/` — served via presigned GET.

## Flow (e.g. change profile photo) — 2 steps, decoupled

1. `POST /api/member/upload/temporary?kind=avatar` (multipart, field `image`, Bearer auth)
   → sharp re-encode → `putObject` to `public/avatars/<userId>/<uuid>.webp`
   → returns `{ image: [{ fileId, url (=key), fullUrl (=public CDN URL), size, type, ... }] }`.
2. FE sends `fullUrl` as `avatarUrl` to the profile update endpoint, which
   persists it as a plain string on `MemberProfile`.
3. On display, FE renders `<img src={image}>` straight from the CDN — backend is
   not in the hot path for `public/*`.

The endpoint path stays `/upload/temporary` for FE wire compatibility even
though files are no longer "temporary" (parity with legacy `FileUploadModel`).

## Env vars (add to `.env` / `.env.example`)

```
S3_ENDPOINT=                       # empty = AWS default; set for MinIO/R2
S3_REGION=ap-southeast-3           # Jakarta
S3_ACCESS_KEY_ID=                  # required in prod
S3_SECRET_ACCESS_KEY=              # required in prod
S3_BUCKET=bb-uploads
S3_FORCE_PATH_STYLE=false          # true for MinIO/R2
S3_PUBLIC_BASE_URL=                # CDN/base for public/* URLs, e.g. https://cdn.brainboost.com
S3_PRESIGN_EXPIRES=900             # presigned GET lifetime (s) for private/*
S3_IMAGE_MAX_DIMENSION=1024        # max image side after resize
S3_IMAGE_WEBP_QUALITY=82           # webp quality 1-100
```

The old `UPLOAD_TEMP_DIR` / `UPLOAD_PUBLIC_BASE_URL` are now dead (kept in
`env.ts` only until confirmed removable). `UPLOAD_MAX_BYTES` still caps multer.

## Infra checklist (one-time, per environment)

1. Create bucket `S3_BUCKET` in the target region.
2. Bucket policy: grant `s3:GetObject` to `*` (or the CDN OAI) **scoped to
   `arn:aws:s3:::<bucket>/public/*`** only. Leave `private/*` with no public grant.
3. IAM user/role for the app, scoped to the single bucket:
   `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `arn:aws:s3:::<bucket>/*`.
   Do **not** grant `s3:*`.
4. (Optional) CloudFront / CDN in front of `public/*`; set `S3_PUBLIC_BASE_URL`
   to its domain.

## Known follow-ups

- **Orphan files:** replacing an avatar overwrites the `avatarUrl` string but the
  old object is left in S3 (not deleted). Decided to leave for now (storage is
  cheap). To reclaim: have the profile update delete the previous key, or add an
  S3 lifecycle rule. Tracked here so it isn't forgotten.
- **Private upload endpoint** not yet exposed — add when report/commerce/KYC
  modules need it.
- Dev with no S3 credentials configured: the client constructs but `putObject`
  fails at call time. Configure a dev bucket or point `S3_ENDPOINT` at a local
  MinIO if offline dev is needed.

## Tests

- `apps/mobile-api/tests/upload-image-processor.spec.ts` — real sharp: resize,
  no-upscale, webp output, non-image rejection.
- `apps/mobile-api/tests/upload-s3-storage.spec.ts` — `aws-sdk-client-mock` for
  put/delete dispatch + key classification; offline presigned-URL signing for
  `private/*`.
- `apps/mobile-api/tests/upload-service.spec.ts` — `uploadImages` key building
  per `kind`, default folder, empty-list / non-image / blocked-ext rejection
  (storage + processor mocked).
