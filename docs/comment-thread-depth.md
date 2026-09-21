# Comment thread depth and notification routing

Answers the app-side contract note *"Comment notifications and thread depth — questions for backend"*
(2026-09-18) and records what changed here on 2026-09-21.

The app caps a thread at two levels — a comment and its replies — because that is what post detail
renders. The API had no such cap, so a reply created from the old standalone comment screen (which a
notification opened, with its composer parented on whatever comment it was given) could land at
depth 3, 4, … Those rows are rendered nowhere in the app and are reachable only by following another
notification.

FE-facing version of all this: `docs/comment-notification-contract.md`.

---

## 1. Answers

### Q1 — field semantics of `member/comment/detail`

One serializer for every comment endpoint (`apps/mobile-api/src/modules/comment/comment.serializer.ts`),
no per-shape variant:

| field | top-level comment | reply |
| --- | --- | --- |
| `commentId` | own id | own id |
| `replyId` | `null` | **parent's id** |
| `parentId` | `null` | parent's id (same value, backend-native alias) |
| `rootCommentId` *(new)* | `null` | thread root's id |
| `postId` | always set | always set |

`replyId` is the parent, never the row's own id — the same meaning `POST member/comment/create`
gives it. The replies list treating `replyId` as the row's own id when liking is an app-side bug: it
sends the parent's id to `/comment/like`, so the like lands on the wrong comment. Use `commentId`.

### Q2 — what `refId` points at

Both comment notifications point at the **new / acted-on** comment, never at the parent:

| event | `refId` | other payload keys |
| --- | --- | --- |
| `comment.created` | the new comment or reply | `postId`, `parentId`, `actorId` |
| `comment.liked` | the liked comment | `postId`, `parentId`, `actorId` — `postId`/`parentId` **added 2026-09-21** |

Transport differences worth knowing:

- **Bell** (`GET /api/member/notification/*`) returns `payload` as an object, so `parentId: null` is
  present on a top-level comment.
- **Push** flattens `payload` into FCM `data` as strings and **drops null values**, so a top-level
  comment carries no `parentId` key at all. Treat an absent key as `null`.

### Q3 — did create enforce a depth limit?

No. `create()` only checked that the parent existed, was not deleted, and belonged to the same post.
`parent.parentId` was never looked at, so any depth was accepted. Fixed — see §2.

### Q4 — does depth > 2 exist in production?

Yes, 19 rows (measured 2026-09-21 on prod `bb_backend`, recursive CTE over `comments`):

| depth | rows |
| --- | --- |
| 1 | 93 368 |
| 2 | 7 899 |
| 3 | 18 |
| 4 | 1 |

Of the depth-3 rows, **13 came from legacy** (`legacy_id` not null, 2025-11 → 2026-06, across 6
posts) — legacy allowed depth 3 too. The other 6 were written by the new app on a **single post**
between 11:57 and 12:00 on 2026-08-16: two real members holding a conversation entirely through
notifications, invisible to everyone including themselves in the feed.

No backfill was run. The volume is too small to justify touching production rows, and flattening
them would also have to repair `count_replies` on both the old and the new parent. If it is ever
wanted, flatten to the thread root and then re-run the counter rebuild.

---

## 2. What changed (2026-09-21)

### R2 — a reply to a reply is reparented, not rejected

`CommentService.create()` resolves the thread root of the requested parent and attaches the new
comment there:

```ts
parentId = (await this.resolveRootId(parent)) ?? parent.id;
```

**Reparent rather than reject** because app 3.3.3 and earlier still offer the action from the old
standalone screen. An error at that point throws away what the member wrote and leaves a button that
simply fails; a reparented comment is at least visible to the whole thread. Rejecting would have
moved the failure rather than removed it — the rows this produced were a real conversation nobody
could see.

Consequences, both accepted:

- The reply notification goes to the author of the **root** comment, not the author of the reply that
  was aimed at. The member being answered is no longer pinged. Adding a second recipient for a code
  path that is about to be deleted on the client was not worth the surface.
- `count_replies` moves to the root as well, which is consistent with where the row now lives.

The walk is bounded at `MAX_THREAD_HOPS = 5`; it only has work to do on the rows that predate the
cap, since everything created from now on is at depth ≤ 2.

### R1 — `rootCommentId`

The requested `parentCommentId` (null for top-level, parent otherwise) already existed under two
names, `replyId` and `parentId`. What routing actually needs is the **thread root**, which differs
from the parent exactly on the rows that break the app today. So the new field is `rootCommentId`:

- `null` when the row *is* the thread root;
- otherwise the id of the top-level ancestor.

`CommentService.detail()` resolves it for real (one extra lookup on a reply). Every other endpoint
falls back to `parentId`, which is the same answer for any row at depth ≤ 2.

Routing from a notification is then one read: open post detail for `postId`, expand
`rootCommentId ?? commentId`, scroll to `commentId`.

### R3 — `postId` on `comment.liked`

`comment.liked` notifications now carry `postId` and `parentId`, mirroring `comment.created`. Before
this, a like notification had only `refId`, so the client had to resolve the comment before it could
open anything — and had nowhere to go at all if that comment had since been deleted, because
`/comment/detail` answers `404 COMMENT_NOT_FOUND` for a deleted row. `postId` in the payload is the
fallback.

---

## 3. Still open

- **No "where is this comment" endpoint.** Expanding the right thread and scrolling to a target still
  means paging `/comment/list` (top-level, `createdAt desc`) and `/reply/list` (`createdAt asc`) until
  the row appears. An `anchorCommentId` parameter, or an endpoint returning the target's page index,
  would be a bigger win for the app's routing work than `rootCommentId` was.
- **The 19 deep rows stay invisible** once the standalone screen is gone. `/comment/list` returns
  top-level only and `/reply/list` returns direct children only, so nothing surfaces them.
- **Old notifications still point at depth-3 rows.** `rootCommentId` is what makes those route
  correctly; a client walking `parentId` itself would open the wrong thread.
