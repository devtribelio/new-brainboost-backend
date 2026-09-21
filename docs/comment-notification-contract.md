# Comment Notifications & Thread Depth — FE (mobile) ↔ BE Contract

Answers the app-side note *"Comment notifications and thread depth — questions for backend"*
(2026-09-18), and records the BE changes that went with it.

- **Status: BE done, not released.** Merged in `bb-backend-new`, not deployed yet. Safe to code
  against; confirm with BE before QA on staging.
- **No migration.** Response and notification-payload changes only.
- **No breaking change.** Every existing field keeps its name and meaning; the new ones are additive.
  Shipped builds keep working.
- **Written:** 2026-09-21.

What crosses the wire: one new field on `CommentModel` (`rootCommentId`), two new keys on the
`newLike` notification payload, and one behaviour change on `create` (reparent).

---

## End-to-end flow

```
  Notification arrives (push or bell), payload.refTable == "comment"
        │
  [FE]  │ 1. GET /api/member/comment/detail?commentId={payload.refId}
        │
  [FE]  │ 2. open post detail  → data.postId
        │    expand thread     → data.rootCommentId ?? data.commentId
        │    scroll + highlight→ data.commentId
        │
  [FE]  │ 3. reply from the post-detail composer
        │    POST /api/member/comment/create { postId, content, replyId }
        │    replyId = the thread's top-level comment id
        │
  [BE]  │ 4. if replyId turns out to be a reply → BE reparents to the root, still 201
```

The thread rule now matches the Tribe design: **two levels**, a comment and its replies. Deeper rows
can no longer be created.

---

## Ground rules

- Same base URL as the mobile API. Standard envelope `{ success, data, meta, error }` — see
  `docs/api-envelope.md`.
- All ids below are UUID v7. Comment endpoints still accept a `legacyId` (int) as input.
- No new endpoints, none removed.

---

## 1. `GET /api/member/comment/detail` — resolve the notification target

Auth optional (`isLiked` is only meaningful with a bearer).

### Request

```
GET /api/member/comment/detail?commentId=<payload.refId>
```

### Response (the part routing uses)

```jsonc
{
  "success": true,
  "data": {
    "commentId": "0190a4d1-...",     // this row's own id
    "replyId": "0190a4c0-...",       // the PARENT's id, null when top-level
    "parentId": "0190a4c0-...",      // alias of replyId (identical value)
    "rootCommentId": "0190a4c0-...", // NEW — id of this thread's top-level comment
    "postId": "0190a4b0-...",        // always set, replies included
    "content": "...",
    "isDeleted": false
  }
}
```

### Field semantics — one answer, same on every comment endpoint

| field | top-level comment | reply |
| --- | --- | --- |
| `commentId` | own id | own id |
| `replyId` | `null` | **parent's id** |
| `parentId` | `null` | parent's id (same value, alias) |
| `rootCommentId` | `null` | thread root's id |
| `postId` | set | set |

`replyId` is **always the parent, never the row's own id** — the same meaning `create` gives it.

> **FE bug found during the audit:** in the replies list, `replyId` is used as the row's own id when
> liking. That sends the parent's id to `/comment/like`, so the like lands on the parent comment.
> Use `commentId`.

### `rootCommentId` vs `parentId`

For any row at depth ≤ 2 — that is, everything created from now on — the two are **identical**. They
differ only on the older depth-3/4 rows, which are precisely the rows that make the app open the
wrong thread today. So:

- **route from a notification using `rootCommentId`**;
- do not walk `parentId` yourself on the client; BE does the walking.

Comment endpoints other than `detail` fill `rootCommentId` from `parentId` (correct at depth ≤ 2).
When you need the value guaranteed correct for an old row, read it from `detail`.

### Errors

| condition | status | code |
| --- | --- | --- |
| `commentId` missing | 400 | `COMMENT_ID_REQUIRED` |
| unknown or deleted | 404 | `COMMENT_NOT_FOUND` |

**A 404 is not a dead end**: the notification payload already carries `postId`, so fall back to
opening post detail without expanding. See §4.

---

## 2. `POST /api/member/comment/create` — reparent, not reject

### Request

```jsonc
{
  "postId": "0190a4b0-...",
  "content": "comment body",
  "replyId": "0190a4c0-..."   // optional — the PARENT's id. alias: parentId
}
```

### New behaviour

| `replyId` points at | result |
| --- | --- |
| omitted | top-level comment |
| a top-level comment | a reply on that comment (unchanged) |
| **a reply** | **201, reparented onto the thread root** |
| a depth-3/4 reply (old row) | 201, reparented onto the thread root |

No new error, no new error code.

**What FE must handle:** on the reparent path the response's `replyId` **differs** from what was
sent (it holds the root). Do not place the result in the UI based on the value you sent — use
`replyId` / `rootCommentId` from the response, or refetch the thread.

Why reparent instead of reject: app 3.3.3 and earlier still offer that action from the old standalone
comment screen. An error there throws away what the member typed and leaves a button that always
fails, whereas a reparented comment is at least visible to the whole thread.

**Side effects:** `replyCount` increments on the **root** comment, not on the reply that was aimed
at. And the reply notification goes to the root comment's author, not the author of the reply that
was aimed at — on this path the person being answered gets no ping.

---

## 3. Notification payloads

`refTable` is **unchanged** (`"comment"`), so existing routing still fires.

### `newComment` / `newReply` / `tag` (event `comment.created`)

```jsonc
{
  "refTable": "comment",
  "refId":    "0190a4d1-...",  // the NEW comment or reply, not the parent
  "postId":   "0190a4b0-...",
  "parentId": "0190a4c0-...",  // null when the new row is top-level
  "actorId":  "0190a49f-..."
}
```

### `newLike` (event `comment.liked`)

```jsonc
{
  "refTable": "comment",
  "refId":    "0190a4d1-...",  // the liked comment
  "postId":   "0190a4b0-...",  // NEW
  "parentId": "0190a4c0-...",  // NEW — null when the liked comment is top-level
  "actorId":  "0190a49f-..."
}
```

Previously `newLike` carried only `refTable` / `refId` / `actorId`.

### Bell vs push — different shapes, read this

| | bell (`GET /api/member/notification/list`) | push (FCM) |
| --- | --- | --- |
| location | `payload` object on each row | flat `data` map |
| value types | as-is | **all strings** |
| null values | key present, value `null` | **key dropped** |
| extras | — | `type`, `notificationId`, `networkId` |

So in a push, **a missing `parentId` key means the comment is top-level** — not missing data.

`type` is one of `newComment` \| `newReply` \| `newLike` \| `tag`.

---

## 4. Suggested routing

```
onCommentNotification(payload):
  detail = GET /comment/detail?commentId=payload.refId
  if 404:
      # the comment has been deleted
      if payload.postId: open post detail(payload.postId); return
      else: open the notification list; return

  open post detail(detail.postId)          # with no preloaded post object
  threadId = detail.rootCommentId ?? detail.commentId
  expand(threadId)
  scrollTo(detail.commentId) + highlight
```

`rootCommentId ?? commentId` covers all three cases at once: the target is top-level (root is
itself), the target is a reply (root is its parent), the target is an old depth-3/4 row (root is what
BE walked to).

---

## 5. Existing production data

Measured on prod, 2026-09-21:

| depth | rows |
| --- | --- |
| 1 | 93 368 |
| 2 | 7 899 |
| 3 | 18 |
| 4 | 1 |

13 of the depth-3 rows are legacy imports; the other 6 were written by the new app on a single post
on 2026-08-16.

**Not backfilled.** Once the standalone comment screen is gone those 19 rows surface nowhere
(`/comment/list` is top-level only, `/reply/list` is direct children only). Old notifications
pointing at them still route correctly through `rootCommentId` — the thread opens — but the target
row itself is not in the list, so `scrollTo` must tolerate not finding it.

---

## 6. Not available (ask separately if FE needs it)

- **"Which page is this comment on".** To expand and scroll, FE still has to page `/comment/list`
  (top-level, `createdAt` **desc**) and `/reply/list` (`createdAt` **asc**) until the row shows up.
  There is no `anchorCommentId` parameter and no endpoint returning the target's page or index.
- **A "this reply was reparented" marker.** None — in the data it is an ordinary reply.

BE spec: `docs/comment-thread-depth.md`.
