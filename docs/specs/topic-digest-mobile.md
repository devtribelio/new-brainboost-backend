# Topic Digest & Topic Detail — Mobile Integration Guide

What BE shipped for the Tribe/topic push work agreed in
`docs/fcm-targeted-push-contract.md` (Addendum 2026-08-03).

Two things are new:

1. a nightly **digest push** (`topicDigest` / `tribeDigest`),
2. `GET /api/member/topic/detail` so a digest tap can render the topic screen.

**Status:** on the backend, behind a kill switch. The digest ships **disabled** —
nothing is sent until ops flips `notification.digestEnabled`. Build against it now;
turning it on is a database edit, not a deploy.

---

## 1. What a member actually receives

Instant per-post pushes are **unchanged** — a new post in a subscribed topic still
pushes right away, and still writes a notification row.

The digest is a second layer on top, for what the member missed:

| | Instant `newPost` | Nightly digest |
|---|---|---|
| When | on publish | one configured hour, default 21:00 WIB |
| How many | one per post | at most **one per member per night** |
| Writes a notification row | yes | **no** — it summarises rows that already exist |
| Subject to the unopened-push brake | yes | no |

Because the digest writes no rows, it never duplicates the in-app list. The rows the
member sees when they open the app are the same per-post rows as always.

**It only counts what is still unread.** A member who kept up during the day has
nothing unread, so they get **no digest at all**. The number in the copy is therefore
always "how many you have not seen", never "how many were posted".

---

## 2. The digest push payload

All `data` values are strings, as FCM requires. **`data` is flat** — the deep-link
fields sit at the top level, not nested under a `payload` object. (The in-app list
response *does* nest them under `payload`; the push does not. The FE resolver already
accepts both.)

### One topic had activity — keep the precise deep link

```json
{
  "notification": { "title": "Mindset", "body": "Ada 9 post baru di Mindset" },
  "data": {
    "type": "topicDigest",
    "refTable": "topic",
    "refId": "019fc67e-bbbb-7000-8000-444455556666",
    "topicName": "Mindset",
    "postCount": "9"
  }
}
```

Route it the normal way: `refTable` + `refId` → topic screen.

### Two or more topics — no single target

```json
{
  "notification": {
    "title": "Tribe",
    "body": "Ada 27 post baru di Mindset, Bisnis, dan 1 topik lain"
  },
  "data": {
    "type": "tribeDigest",
    "postCount": "27",
    "topicCount": "3"
  }
}
```

There is **no `refTable` / `refId`** here — that is the case the agreed precedence rule
was written for: fall through to routing by `type`, and open the Tribe section's default
view. Topic names in the body are ordered by how much activity each had.

`postCount` and `topicCount` are **display only**. Never route on them.

### Frozen values

`topicDigest` and `tribeDigest` are **frozen** now that they route. BE will never rename
them for copy reasons — a rename would break the deep link on every already-installed
build. New destinations get new values.

### Muted topics

A muted topic is dropped **before** counting, so its posts are not in the total and its
name is not in the body. If every topic with activity is muted, that member gets **no
digest** that night. Their notification rows are still written, as always.

---

## 3. `GET /api/member/topic/detail`

Hydrates the topic screen after a cold-start digest tap, when the app has only a
`topicId`.

```
GET /api/member/topic/detail?topicId=<uuid | legacyId>
Authorization: Bearer <token>   (optional)
```

`topicId` accepts the topic UUID **or** its legacyId int as a string, same as the rest
of the API.

### Response — 200

```json
{
  "success": true,
  "data": {
    "topicId": 12,
    "id": "019fc67e-bbbb-7000-8000-444455556666",
    "name": "Mindset",
    "icon": "https://cdn.brainboost.com/topics/mindset.png",
    "iconType": "image",
    "type": "PUBLIC",
    "countPost": 42,
    "orderNumber": 0,
    "isSubscribeTopic": true,
    "isMute": false,
    "networkId": "019fc67e-aaaa-...",
    "description": "Topik seputar pola pikir",
    "iconUrl": "https://cdn.brainboost.com/topics/mindset.png",
    "isActive": true,
    "createdAt": "2026-05-11T12:00:00.000Z"
  },
  "meta": null,
  "error": null
}
```

Same field shape as an entry in `GET /topic/list` — the same serializer produces both,
so the existing `TopicModel` parses it with no changes.

Two fields behave differently from the list, on purpose:

- **`countPost` is real here.** In `/topic/list` it is still always `0` (an accurate
  count would mean one query per row). If your topic header shows a post count, take it
  from this endpoint.
- **`isSubscribeTopic` and `isMute` are resolved for the caller.** Without a token both
  are `false` — the endpoint still returns the topic, so share links work, but it cannot
  know anyone's subscribe or mute state.

### Errors

| Situation | Status | `error.code` |
|---|---|---|
| `topicId` missing | 400 | `TOPIC_ID_REQUIRED` |
| `topicId` neither UUID nor int | 400 | `ID_FORMAT_INVALID` |
| Topic unknown **or** deactivated | 404 | `TOPIC_NOT_FOUND` |

The 404 is the point of this endpoint: it distinguishes "this topic is gone" from "the
request was malformed", which a list endpoint returning an empty array cannot. On 404,
fall back to the Tribe root rather than showing an empty topic screen.

---

## 4. Mute — naming differs from the contract

The contract sketched mute as `action: "mute"` on the subscribe endpoint plus a field
called `isMuteNotification`. **That is not what shipped.** Mute is a generic mechanism
covering posts and networks as well as topics, so it has its own endpoint:

| Contract said | Actually shipped |
|---|---|
| `POST member/topic/subscribe { topicId, action: "mute" }` | `POST /api/member/notification/mute { scope: "topic", refId }` |
| `isMuteNotification` on `TopicModel` | **`isMute`** on `TopicModel` |

Behaviour is identical to what was agreed — mute is independent of subscribe, enforced
at send time on BE, and the notification rows are still written. Only the names differ.
Full details: `docs/notification-mute-mobile.md`.

---

## 5. What is not built

- **No endpoint reports mute state for a post or a network**, and there is no
  list-of-mutes endpoint. Topics are covered (`isMute` on list and detail); the others
  are not.
- **No BE control over the digest hour per member.** One hour applies to everyone,
  Asia/Jakarta. The FE must not assume or display a send time.
- **A dormant member keeps receiving a digest every night.** The unopened-push brake
  does not apply to it. Known and accepted for now; if it becomes a complaint, BE adds a
  brake with no client change.
- **`android.priority`, `apns-priority` and `channel_id` are NOT being sent yet** —
  checklist items 7 and 8 of the contract. Every push today is just
  `{ token, notification, data }`. The `notification` block is there, so closed-app
  display works (item 1 ✅), but without `channel_id` Android falls back to a
  low-importance channel: status-bar entry, no heads-up, no sound. This affects *all*
  pushes, not only the digest. BE-side fix, no client change — raise it if the quiet
  delivery is what you are seeing on device.

---

## 6. Testing before it is switched on

The digest is off by default, so nothing arrives until ops enables it. To exercise the
tap-handling path meanwhile, send yourself a test FCM message with the exact `data`
blocks from §2 — that is all the routing code sees.

For the detail endpoint, remember tokens change on reinstall: open the app and log in
once so `syncDeviceToken()` registers, otherwise pushes go to a dead token.

---

## 7. Related

- `docs/fcm-targeted-push-contract.md` — the agreed FE ↔ BE contract
- `docs/notification-mute-mobile.md` — mute endpoints and semantics
- `docs/api-envelope.md` — response envelope
- Swagger — `/api/docs`, tags **Topic** and **Notification**
