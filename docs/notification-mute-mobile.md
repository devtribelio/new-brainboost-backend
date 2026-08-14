# Notification Mute — Mobile Integration Guide

How to let a member silence notifications from a specific post, topic, or network.

**Status:** implemented on the backend. `post` and `network` scopes have existed for a
while; `topic` is new (2026-08-03). Since 2026-08-04 a mute silences the **push only** —
see [Behaviour changes](#7-behaviour-changes).

---

## 1. What mute is (and is not)

Mute is **per object**, not per member. A member does not "turn notifications off" —
they silence one specific post, topic, or network, and everything else keeps arriving.

**Mute silences the push, not the record.** The notification is still written and still
shows up in `GET /notification/list`, unread, counting toward `meta.unread` like any
other. What the member loses is the phone buzzing, not the history of what happened
while they were away. So a member who mutes a busy topic and opens the app later will
find those items waiting — that is intended, and the UI copy should not promise
otherwise.

Mute **does not**:

- hide the content — muted posts and topics still appear in the feed and list; only the
  push stops,
- affect other members — it is entirely private to the member who set it,
- silence payment and commission notifications — those always arrive (see
  [§6](#6-what-mute-never-silences)),
- work as a strict hierarchy — each mute is its own record. Muting a topic does not mute
  its parent network. A network mute *does* cover notifications from posts that carry that
  `networkId`, but that is matched per post, not inherited from the topic, so do not
  present network mute in the UI as "mutes every topic inside".

---

## 2. Endpoints

Both require `Authorization: Bearer <access_token>`.

```
POST /api/member/notification/mute
POST /api/member/notification/unmute
```

### Request body — identical for both

```json
{
  "scope": "topic",
  "refId": "019fc67e-bbbb-7000-8000-444455556666"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `scope` | string | yes | `"post"` \| `"topic"` \| `"network"` |
| `refId` | string | yes | The object's UUID **or** its legacyId int as a string (`"123"`) |

`refId` accepts both id forms, the same as the rest of the API. The int is resolved to
the UUID server-side.

### Response — 200

```json
{
  "success": true,
  "data": { "scope": "topic", "refId": "019fc67e-bbbb-...", "muted": true },
  "meta": null,
  "error": null
}
```

`data.refId` is **always the UUID**, even when the request passed a legacyId. `data.muted`
is `true` after `/mute` and `false` after `/unmute`.

### Idempotency

Both are safe to call repeatedly. Muting something already muted returns `200` and changes
nothing; unmuting something that was never muted does the same. No need to check current
state before calling.

To unmute, send the **same `scope`** you muted with. The id form may differ — mute by UUID
then unmute by legacyId works fine, since both resolve to the same row.

---

## 3. What each scope silences

Each row below means "no push for these"; the in-app entries still arrive (see §1).

| Scope | Silences |
|---|---|
| `post` | Every notification from that one thread: new comments, replies to your comment, tags, likes on the post, likes on your comments in it |
| `topic` | Everything above **for every post in the topic**, plus the "new post in this topic" notification |
| `network` | Everything originating from that community: posts/comments/likes carrying that `networkId`, plus join requests, join approvals, and new-member notices |

Note the breadth of `topic`: it is not only "new post" notifications. A member who mutes a
topic and then keeps commenting there will not be told when someone replies to them.

**Word your UI accordingly.** "Mute new posts" would be misleading — prefer something like
*"Bisukan notifikasi dari topik ini"*.

---

## 4. Reading the current state

### Topics — available

`GET /api/member/topic/list` returns `isMute` on every row, so the bell toggle can be
rendered from the list response with no extra request:

```json
{
  "topicId": 12,
  "name": "Belajar Trading",
  "isSubscribeTopic": true,
  "isMute": false
}
```

- `isMute` is independent of `isSubscribeTopic` — a member can mute a topic they never
  subscribed to, and both flags can be `true` at once.
- It is present on every variant of the list, including `?isSubscribe=true|false`.
- For anonymous callers it is always `false` (mute is per member).

### Posts and networks — not available yet

There is currently **no** endpoint that reports whether a given post or network is muted,
and no endpoint that lists a member's mutes. If the UI needs a bell toggle on a post or a
network, ask the backend team — the fix is the same shape as `isMute` on topics.

Do not rely on local storage as a substitute: it goes stale as soon as the member switches
device or reinstalls.

---

## 5. Errors

| Situation | Status | `error.code` |
|---|---|---|
| `scope` or `refId` missing / not a string | 400 | `NOTIFICATION_SCOPE_REQUIRED` |
| `scope` outside the three allowed values | 400 | `NOTIFICATION_SCOPE_INVALID` |
| `refId` is neither a UUID nor an int | 400 | `ID_FORMAT_INVALID` |
| legacyId given but no such row | 404 | `POST_NOT_FOUND` / `TOPIC_NOT_FOUND` / `NETWORK_NOT_FOUND` |
| Missing / malformed `Authorization` header | 401 | `BEARER_TOKEN_MISSING` |
| Token is not a member-scope token | 401 | `MEMBER_TOKEN_REQUIRED` |
| Session was revoked (logout, password change) | 401 | `SESSION_REVOKED` |

Standard envelope — see `docs/api-envelope.md`.

---

## 6. What mute never silences

Transactional notifications are always delivered regardless of any mute:

`paymentSuccess`, `paymentPending`, `paymentRefunded`, `subscriptionRenewed`,
`commissionEarned`

A member must never miss a payment receipt or a payout notice because they silenced a
community. Do not present these as mutable in the UI.

---

## 7. Behaviour changes

Relevant if the app already integrated mute before these dates.

### 2026-08-04 — mute stops the push, no longer the notification

Until now a mute suppressed the notification **row** as well, so a member who muted a
topic lost that history permanently — the entries never existed and unmuting could not
bring them back. Now the row is always written and only the push is withheld.

What changes for the app:

- The notification list and `meta.unread` now include items from muted objects. A member
  who mutes a busy topic will see the badge climb; they simply are not interrupted.
- Nothing arrives on the device for a muted object, exactly as before.
- No request or response shape changed — **no client release required**. Only reconsider
  UI copy that promised "you will not see these anymore".

A suppressed push also no longer spends the member's unopened-push budget (see
`docs/notification-port.md`), so muting one noisy topic can't quietly throttle pushes
from the topics they still follow.

### 2026-08-03 — topic scope + enforcement fixes

- **`scope: "topic"` is now accepted.** Previously only `post` and `network`; sending
  `topic` returned 400.
- **Mute is now actually enforced.** It used to be honoured only for comment
  notifications — likes, network events, and everything else ignored it. All of those now
  respect mute.
- **`unmute` now validates `scope`.** An unknown scope used to return `200` while silently
  doing nothing, which looked like success. It now returns `400`.
- **A legacyId `refId` no longer 500s.** It used to reach the database as a raw int and
  fail with an internal error; it is now resolved to the UUID.

Request and response shapes did not change, so **no client release is required** for the
mute/unmute calls the app already makes.

---

## 8. Related

- `docs/notification-port.md` — notification architecture, recipient resolution, push
- `docs/api-envelope.md` — response envelope and pagination
- Swagger — `/api/docs`, under the **Notification** tag
