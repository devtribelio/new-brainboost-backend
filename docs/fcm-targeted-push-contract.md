# FCM Targeted Push — FE ↔ BE Contract

Moving from console "blast" campaigns to **server-triggered, per-user** pushes
(e.g. "someone liked your post"), reusing FCM but aimed at one user's devices
instead of broadcasting.

This feature lives on **both sides of the wire**, which is what makes it
confusing. The point of this doc is to draw the boundary: every step below is
labelled with its owner, and there are exactly **two things that cross the
wire** — a token going up, and a push payload coming down. Get those two right
and the rest is independent.

- **Drafted:** 2026-06-04, branch `feat/fcm-targeted-push`.
- **Already proven:** purchase pushes already arrive on a **closed** app (seen
  in a prior production build). That is live evidence the BE method works
  end-to-end — BE already sends a targeted, per-token, notification-type
  message. The new work is BE reusing that same path for notification-list
  events, plus a few FE fixes for routing + channel.

---

## The end-to-end flow (who owns each step)

```
  EVENT: user B likes user A's post
        │
   [BE] │ 1. Write the notification row (shows in member/notification/list)
        │ 2. Look up ALL of user A's FCM tokens (stored from member/auth/devices)
        │ 3. For each token, POST FCM HTTP v1 messages:send
        │       - notification{title,body}   ← so a CLOSED app still displays it
        │       - data{refTable,refId,type}  ← so a TAP can deep-link
        │       - android.priority=high, apns-priority=10, channel_id
        ▼
  [FCM] │ 4. Google delivers to the device
        ▼
   [OS] │ 5. App CLOSED/BACKGROUND → Android tray / iOS APNs draws the
        │    notification itself. NO app code runs. (This is why it works
        │    when the app is dead — display is the OS's job, not ours.)
        │    App FOREGROUND → OS suppresses it; FCMService shows a local notif.
        ▼
 [USER] │ 6. Taps the notification
        ▼
   [FE] │ 7. FCMService receives the tap (onMessageOpenedApp / getInitialMessage)
        │ 8. _navigateToScreen reads data{refTable,refId} → opens post/comment
```

**Ownership in one line:** BE owns *deciding to send and what to send* (steps
1–3). Google + the OS own *delivery and display* (steps 4–5) — we don't write
that code. FE owns *what happens on tap* (steps 7–8) and *getting the token to
BE in the first place*.

| Step | Owner | Notes |
| --- | --- | --- |
| Store token per device | **FE → BE** | FE posts `member/auth/devices`; BE persists per user |
| Decide an event warrants a push | **BE** | same events as the notification list |
| Build + send the v1 payload | **BE** | per-token; must include `notification` block |
| Deliver | Google FCM | — |
| **Display when app is closed** | **OS** | not app code — needs a `notification` block |
| Display when app is foreground | **FE** | `FCMService._showLocalNotification` |
| Route on tap | **FE** | `_navigateToScreen` by `refTable`/`refId` |
| Prune dead tokens | **BE** | on `UNREGISTERED` 404 / `INVALID_ARGUMENT` 400 |

---

## Wire crossing #1 — token goes up (FE → BE)

Already implemented. On every logged-in app start (and on token rotation), the
app sends its current FCM token:

- **Endpoint:** `POST member/auth/devices`
- **FE sends:** `deviceId`, `platform` (`"android"` | `"ios"`), `fcmToken`
- **BE returns:** a cloud-messaging id (stored locally as `cloudMessagingId`,
  used at logout to unregister)
- **FE code:** `FCMService.syncDeviceToken()` (single source of truth), called
  from `TokenCubit.onUpdateNotification()` at startup and from `onTokenRefresh`.

**BE must:** store these **per user, many-per-user** (a user has several
devices / reinstalls), and target every active token when sending.

---

## Wire crossing #2 — push comes down (BE → device)

This is the part to get right. Canonical v1 payload for "Alex liked your post":

```json
{
  "message": {
    "token": "<one of user A's device tokens>",
    "notification": { "title": "New like", "body": "Alex liked your post" },
    "data": { "type": "newLike", "refTable": "like", "refId": "<post-uuid>" },
    "android": {
      "priority": "high",
      "notification": {
        "channel_id": "high_importance_channel",
        "notification_priority": "PRIORITY_HIGH"
      }
    },
    "apns": {
      "headers": { "apns-priority": "10", "apns-push-type": "alert" },
      "payload": { "aps": {
        "alert": { "title": "New like", "body": "Alex liked your post" },
        "sound": "default", "badge": 1
      } }
    }
  }
}
```

Non-negotiables for "shows when the app is closed":
- **Include the `notification` block.** Data-only messages do **not** show a
  tray notification when terminated, and on iOS won't run at all after a
  force-quit. The visible text must be in `notification` (or notification+data).
- **`android.priority: "high"`** + **`apns-priority: "10"`** to wake a dozing
  device.
- **`android.notification.channel_id: "high_importance_channel"`** — must match
  the channel the app declares, or the OS uses a low-importance fallback (no
  heads-up / sound).

---

## The `data` contract — what makes FE routing fire

**Verified 2026-06-05 against staging `member/notification/list`.** The deep-link
fields are **nested inside a `payload` object** (not flat), and the shape varies
by type. The FE flattens `payload` before routing — the in-app `NotificationModel`
reads its keys via `readValue: _fromPayload`, and the push handler runs
`_resolvePayload(data)` (handling `data['payload']` as a JSON string or a map),
both falling back to flat keys for older payloads.

Real shape from the list endpoint:

```jsonc
// paymentSuccess
{ "title": "Payment successful", "type": "paymentSuccess",
  "payload": { "refTable": "commerce_payment", "refId": "<paymentId>",
               "productCode": "wha4q5y88", "productId": "<uuid>",
               "amount": 298000, "transactionId": "<uuid>" } }
// newComment
{ "type": "newComment",
  "payload": { "refTable": "comment", "refId": "<commentId>",
               "postId": "<postId>", "parentId": null, "actorId": "<uuid>" } }
// newLike (post) / newPost
{ "type": "newLike",
  "payload": { "refTable": "post", "refId": "<postId>", "actorId": "<uuid>" } }
```

Full mapping (FE routes on `payload.refTable` + `payload.refId`):

| type | `refTable` | `refId` | key payload fields | FE tap result |
| --- | --- | --- | --- | --- |
| newPost | `post` | postId | actorId, networkId | ✅ **post detail** |
| newLike (on a post) | `post` | postId | actorId | ✅ **post detail** |
| newComment / newReply / tag | `comment` | commentId | postId, parentId, actorId | ✅ **comment detail** |
| newLike (on a comment) | `comment` | commentId | actorId | ✅ **comment detail** |
| paymentSuccess / subscriptionRenewed | `commerce_payment` | paymentId | **productCode** (slug), productId, amount, transactionId | ✅ **course audio player** (by productCode) |
| paymentRefunded | `commerce_payment` | paymentId\|null | productCode?, productId? | ✅ audio if productCode present, else Beranda |
| requestJoin / approveJoin / memberJoin | `network*` | requestId / networkId | networkId, memberId, … | ⛔ **display only** — no screen exists yet |

Routing today (`FCMService._navigateToScreen` + `notification_page.dart`):
- `post` → **post detail** (`refId` = postId).
- `comment` → **comment detail** (`refId` = commentId; FE fetches it to get postId).
- `commerce_payment` → **course audio player** (`ProductAudioPage` by
  `payload.productCode`), matching the post-payment webview flow — *not* product
  detail. Beranda fallback if `productCode` is missing.
- `network*` (3 types) → **display only, deferred.** The deep-link targets
  (join-request approval, network/member detail) **don't exist in the app yet** —
  `community_page.dart` is a single Timeline/Topik view. Tapping these falls back
  to **Beranda**. Wire when that community feature is built.
- **Broken/unknown/incomplete links** (unknown refTable, missing ids, fetch
  failure on a deleted post/comment, unlaunchable url, empty data) → **Beranda**.
- legacy flat `refTable`/`refId`/`postId`/`url` keys still handled.

---

## Addendum 2026-08-03 — Tribe destinations (`tribe`, `topic`)

New ask: BE wants pushes that land on the **Tribe timeline** or on a **specific
topic** (e.g. "3 new posts in Mindset", "your subscribed topic has a new post").

**No response-schema change is needed.** `payload` is already free-form and the
FE flattens it, so BE can add these the same way it adds any other type. What is
needed is (a) two new `refTable` values, (b) one BE endpoint for topic
hydration, (c) FE routing code (ships in an app release).

### Design rule: BE names CONTENT, never UI

The Tribe tab is being **revamped in the next major update** (tab count, names
and order all change). So the contract must not encode anything the revamp can
move:

- ⛔ **Never send a tab index** (`tab: 2`) — indices are an FE implementation
  detail of `MainPage`'s IndexedStack and will shift.
- ⛔ **Never send a tab/route name** (`tab: "timeline"`, `route: "/main"`) —
  screen names change with the revamp.
- ✅ **Send the content identity only** (`refTable` + `refId`). The FE owns the
  `refTable → screen` mapping and updates it in the same release as the revamp.

That way a push sent today still resolves after the revamp: `topic` still means
"that topic's posts", wherever the FE decides to show them.

### The two new destinations

| `type` (BE) | `refTable` | `refId` | extra payload | FE tap result |
| --- | --- | --- | --- | --- |
| e.g. `tribeDigest`, `tribeAnnouncement` | `tribe` | *(omit / empty)* | — | Tribe section, its default landing view |
| e.g. `newTopicPost`, `topicDigest` | `topic` | **topicId** (uuid) | `topicName` (optional, see below) | Topic detail (that topic's post list) |

Example push `data` (all values strings, as FCM requires):

```jsonc
// "New post in a topic you follow"
{ "type": "newTopicPost",
  "payload": { "refTable": "topic", "refId": "<topicId-uuid>",
               "topicName": "Mindset", "postId": "<postId>" } }

// "Tribe digest" — no specific target, just open Tribe
{ "type": "tribeDigest",
  "payload": { "refTable": "tribe" } }
```

Note on `postId`: if the push is really about **one post**, prefer the existing
`refTable: "post"` — it already works on shipped builds today, no new release
needed. Use `topic` only when the destination is genuinely the topic feed.

### Forward-compat rules (both sides)

1. **FE:** unknown `refTable` → Beranda, never a crash or blank screen. Already
   true (`_navigateToScreen` default branch).
2. **BE:** old installs will not understand `tribe`/`topic` and will land on
   Beranda. Acceptable graceful degradation. If the miss rate matters, gate the
   campaign on app version at send time.
3. **Neither side versions the vocabulary.** New destination = new `refTable`
   value, additive. Existing values are **never** repurposed — `post` must not
   later mean something else, since old builds still route on it.
4. **The revamp must keep the mapping.** When the Tribe tabs change, update
   `_navigateToScreen` + `notification_page.dart` in that same PR; the two
   `refTable` values above are the contract and must keep resolving.

### BE work needed: hydrate a topic by id

`member/topic/list` (page, perPage, **code**, keyword) is the only topic read
today, and it **cannot fetch one topic by id**. The FE needs a topic's `name`,
`icon`, `countPost` and `isSubscribeTopic` to render the topic screen header
after a cold-start push.

Two options, pick one:

**A. `GET member/topic/detail?topicId=<uuid>`** → one `TopicModel`, same field
shape as the list entries. **FE recommends this.**

| | |
| --- | --- |
| ✅ | Keyed on `topicId` alone. Nothing else has to be known or cached. |
| ✅ | Deleted/invalid topic → **404**, unambiguous. FE falls back to Tribe root. |
| ✅ | Reusable later for topic share links (`/t/topic/...`) without rework. |
| ⛔ | New route + controller + auth check on BE. |
| ⛔ | New use case + repo method on FE (small, ~30 lines). |

**B. Add an optional `topicId` filter to `member/topic/list`** → 1-item array.

| | |
| --- | --- |
| ✅ | Tiny BE change: one extra where-clause on an existing query. |
| ✅ | Zero new FE models. One new field on `TopicsQueryRequest`, reuses `GetTopicsUseCase`. |
| ⛔ | The endpoint **requires `code`** (network code). The app has it cached from the last `member/info` (`getTimelineNetworkCode()`), so it is normally present on a cold start, but it is a value owned by another feature. If it is ever empty or stale, the deep link breaks in a way that has nothing to do with topics. |
| ⛔ | Missing/deleted topic returns an **empty array**, indistinguishable from "bad network code" or "no topics" — the FE cannot tell the user anything useful. |
| ⛔ | Response is wrapped in pagination meta for a single row. Harmless, just noise. |
| ⛔ | A "list" endpoint that callers rely on to return exactly one row invites future breakage (e.g. someone adds a default filter). |

**Verdict:** B is genuinely cheaper and the network-code risk is smaller than it
first looks (the value is persisted, not per-session). The deciding factor is
error handling: a push deep link needs to distinguish "topic is gone" from
"request was malformed", and only A does that.

> ✅ **AGREED 2026-08-03: option A.** `GET member/topic/detail?topicId=<uuid>`
> returns one `TopicModel` (`id`, `name`, `icon`, `iconType`, `type`,
> `countPost`, `orderNumber`, `isSubscribeTopic`, `isMuteNotification`), with
> `isSubscribeTopic` / `isMuteNotification` resolved for the authenticated
> caller. 404 on a deleted or unknown topic.

`isSubscribeTopic` must be resolved **for the authenticated caller**, not
globally, since the topic screen shows the subscribe button state.

### FE work needed (our side, one release)

- `_navigateToScreen`: add `tribe` and `topic` cases.
- `notification_page.dart`: same two cases, so the in-app list and the push
  agree.
- Open the Tribe section from the root navigator. `MainCubit.setCurrentIndex(2)`
  exists but the cubit is not reachable from `navController.context`; use the
  same stash/handshake pattern as the cold-start tap, or a `/main?section=tribe`
  query param resolved in `MainPage.screen`. Keep the section key semantic, not
  an index, for the same revamp reason as above.
- `TopicDetailPage.screen` currently hard-casts `state.extra as TopicModel` —
  it **crashes** if pushed without `extra`. Make `extra` optional and hydrate
  from the new endpoint when absent.
- Add a `GetTopicDetailUseCase` (or a `topicId` field on `TopicsQueryRequest`,
  depending on which option BE picks).

### Routing key: `refTable` vs `type` — agreed resolution

BE asked to use `type` instead of `refTable` for **Tribe**, since Tribe carries
no id and `refTable` literally names a DB table (there is no `tribe` table).
Agreed, with one rule that keeps it unambiguous.

**FE resolution order in `_navigateToScreen` (and the in-app list):**

1. `refTable` + non-empty `refId` → route by `refTable` *(unchanged; all shipped
   destinations keep working)*
2. else `type` → route by `type` *(new; for param-less destinations)*
3. else legacy flat `postId` / `url`
4. else Beranda

So:

| destination | keyed on | payload |
| --- | --- | --- |
| Tribe section (no param) | **`type`** | `{ "type": "tribeDigest" }` |
| Topic detail (has a param) | **`refTable` + `refId`** | `{ "type": "newTopicPost", "payload": { "refTable": "topic", "refId": "<topicId>" } }` |

**The rule this buys:** anything with an id keeps using `refTable`+`refId`;
`type` is only consulted when there is nothing to point at. A payload must never
send a routing `refTable` and a *different* routing `type` — `refTable` wins and
the `type` is ignored.

**Cost BE must accept:** `type` stops being free copy metadata. Today it only
picks an icon in the in-app list, so renaming it was harmless. Once a `type`
value routes, **it is frozen** — renaming `tribeDigest` for copy reasons
silently breaks the deep link on every already-shipped build. Add a new value
instead, never rename.

---

## Addendum 2026-08-03 — Mute topic notifications

Shipping alongside the topic pushes, to control the noise they create.

### Mute is NOT unsubscribe

They must be two independent flags:

- **subscribe** — "show me this topic's posts in my feed" *(content)*
- **mute** — "stop pushing me about it" *(delivery)*

If mute is folded into unsubscribe, the only way to stop the pings is to lose
the feed, which is the opposite of what the feature is for. Default state:
subscribed + **unmuted**.

### Enforcement is BE-side, non-negotiable

The FE **cannot** implement mute. A push with a `notification` block is drawn by
the OS before any app code runs (that is exactly why closed-app pushes work, see
"Wire crossing #2"). So mute must be checked **at send time**, when BE builds
the recipient list. An FE-side check would only be able to hide the in-app row,
after the phone already buzzed.

### API shape

Smallest change: reuse the existing subscribe endpoint's `action` field.

```jsonc
// POST member/topic/subscribe
{ "topicId": "<uuid>", "action": "mute" }     // or "unmute"
// existing values "subscribe" / "unsubscribe" unchanged

// response (SubscribeModel) — one new field
{ "memberId": "...", "id": "<topicId>",
  "isSubscribeTopic": true, "isMuteNotification": true }
```

And `isMuteNotification` (bool) added to **`TopicModel`**, returned by
`member/topic/list` and the new topic detail endpoint, resolved **for the
authenticated caller** — the topic screen needs it to draw the toggle state on
first paint.

If BE prefers a separate route, `POST member/topic/mute { topicId, isMute }`
works identically; the FE cost is the same. Reusing `action` just avoids a new
endpoint + model.

### `type` registry — what exists today vs what is new

**Today `type` does not route anything.** It is read in exactly one place,
`notification_page.dart:322`, to pick the list icon. Routing is 100% `refTable`.
So adding type-based routing **cannot break** post / comment / payment / share
flows — they never consulted `type`.

| `type` | used today | routes? | notes |
| --- | --- | --- | --- |
| `newPost` | ✅ icon `post.svg` | no (routes via `refTable: post`) | existing |
| `newComment` / `newReply` / `tag` | ✅ icon `comment.svg` | no (`refTable: comment`) | existing |
| `newLike` | ✅ icon `like.svg` | no (`refTable: post`\|`comment`) | existing |
| payment / network types | falls to default icon | no (`refTable: commerce_payment`\|`network*`) | existing |
| **`tribeDigest`** | ❌ **new** | ✅ **yes** — opens Tribe | no id to point at, so `type` is the routing key |
| **`topicDigest`** | ❌ **new** | no — routes via `refTable: topic` + `refId` | `type` only picks the icon |

**`tribeDigest` semantics — write this down for future use:** it means *"there
is activity across the topics this member subscribes to, with no single
target."* It does **not** mean "/main tab 2". Today the FE resolves it to the
Tribe section's default view. After the tab revamp, if a "subscribed topics"
view exists, the FE re-points `tribeDigest` at it **with no BE change** — that
is the whole payoff of keying on content instead of UI.

### Digest push shape

**"Digest" = the grouped push BE already described**: one notification saying
"Ada 12 post baru di Mindset" instead of 12 separate notifications, one per
post. Same thing, just the standard name for it. Pin its payload down:

**Schedule (decided 2026-08-03):** BE runs a **daily job, e.g. 21:00**, counts
what is new per member, and sends **at most one push per member per day**. No
per-post pushes, no throttle logic needed anywhere else.

The exact hour and its timezone handling are **entirely BE's** — the FE never
reads or assumes a send time, it only reacts to whatever arrives.

**Multi-topic rule (agreed 2026-08-03):** a member may have new posts in several
subscribed topics. Sending one push per topic re-creates the noise the digest
exists to remove. So still send **exactly one push**, and branch the *shape* on
how many topics had activity:

```jsonc
// CASE 1 — exactly one topic has new posts → keep the precise deep link
{ "type": "topicDigest",
  "notification": { "title": "Mindset", "body": "Ada 12 post baru" },
  "payload": { "refTable": "topic", "refId": "<topicId>",
               "topicName": "Mindset", "postCount": "12" } }

// CASE 2 — two or more topics → no single target, so open Tribe
{ "type": "tribeDigest",
  "notification": { "title": "Tribe", "body": "Ada 27 post baru di Mindset, Bisnis, dan 1 topik lain" },
  "payload": { "postCount": "27", "topicCount": "3" } }
```

Why branch instead of always sending case 2: most members subscribe to a handful
of topics and on a given day usually only **one** has activity. Case 1 is the
common path, and it lands the user exactly where the content is. Case 2 is the
honest fallback when there is genuinely no single destination. Same cap of one
push per day either way.

`postCount` / `topicCount` as **strings** (FCM requires it), display only — the
FE routes on `refTable`/`refId` (case 1) or `type` (case 2), never on the count.

**Mute interacts here:** BE excludes muted topics **before** counting. If the
only topic with new posts is muted, that member gets **no push at all** that day
(the notification-list rows are still written, per Q5).

### FE work

- `TopicSubscribeRequest.action` already exists, so mute/unmute is the same call
  with a new value; add `isMuteNotification` to `SubscribeModel` + `TopicModel`.
- Toggle on `TopicDetailPage`, next to the existing subscribe button
  (`TopicSubsButton`). Optimistic flip, revert on error — same pattern as
  subscribe.
- Copy: Indonesian, no em dash. Suggest "Bisukan notifikasi" / "Notifikasi
  dibisukan".

### Notification-list rows: one row PER TOPIC

Agreed 2026-08-03, and note it differs from the push:

- **Push** — at most **one per member per day** (merged across topics when
  more than one has activity).
- **List rows** — **one row per topic with activity**, never one per post. A
  member with new posts in 3 topics gets 3 rows:

```jsonc
{ "title": "Mindset", "message": "Ada 12 post baru", "type": "topicDigest",
  "payload": { "refTable": "topic", "refId": "<topicId>",
               "topicName": "Mindset", "postCount": "12" } }
```

This falls out nicely: even when the *push* was the merged `tribeDigest` (case 2
above), opening the app gives the member a precise per-topic entry point for
each one. Every row routes on `refTable: topic` + `refId`, which the FE already
handles once the topic case ships.

Unread badge therefore counts topics with activity, not posts.

---

## Agreed contract — summary

Everything below is settled as of **2026-08-03**. Open items are marked.

| # | Decision | Owner |
| --- | --- | --- |
| 1 | Tribe (no param) routes on **`type: "tribeDigest"`**; topic routes on **`refTable: "topic"` + `refId`** | both |
| 2 | FE precedence: `refTable`+`refId` → `type` → legacy `postId`/`url` → Beranda | FE |
| 3 | A routing `type` value is **frozen**; add new values, never rename | BE |
| 4 | Payload never contains a tab index or route name | BE |
| 5 | **Option A**: new `GET member/topic/detail?topicId=` → one `TopicModel`, 404 if gone | BE |
| 6 | Mute = `POST member/topic/subscribe { topicId, action: "mute"\|"unmute" }`; `isMuteNotification` added to `SubscribeModel` + `TopicModel` | BE |
| 7 | Mute is independent of subscribe, and is enforced **at send time** on BE | BE |
| 8 | Muted topics excluded **before** counting; all-muted → no push that day | BE |
| 9 | Muted topic **still writes** notification-list rows | BE |
| 10 | One push per member per day, scheduled job; **hour + timezone entirely BE's** | BE |
| 11 | 1 topic with activity → topic deep link; 2+ → `tribeDigest` to Tribe | BE |
| 12 | List rows: **one per topic**, not one per post | BE |
| 13 | All `data` values are strings, incl. `postCount` / `topicCount` | BE |

### Still open

1. [ ] Confirm the audience for topic pushes is "members subscribed to this
       topic". If so BE fans out to those members' device tokens — **no Firebase
       topic subscription needed**, and the app keeps *not* calling
       `FirebaseMessaging.subscribeToTopic` (it never has).
2. [ ] Final `type` strings, since they are frozen once shipped. FE assumes
       `tribeDigest` and `topicDigest`.
3. [ ] Mute scope is **per topic** for this patch. A global "all Tribe
       notifications" switch can come later as a member-level setting; it is not
       in this contract.

---

## Confirm-with-BE checklist

The notification-list payload is verified; the remaining questions are about
the **FCM push** payload (which we can't inspect directly), since the list and
the push are built separately on BE.

1. [ ] 🔴 **The title is sent as the FCM `notification` block** (`notification.
       title` + `body`), not only inside `data`. If the title only rides in
       `data`, **closed apps display nothing** — the OS only draws the
       `notification` block. *(Closed-app pushes already display, so this is
       likely already true — worth a final confirm.)*
2. [ ] 🟠 **The push `data` carries the same `payload` fields as the list.** The
       FE accepts either a nested `data['payload']` (JSON string) or flat keys.
       Confirm the push includes `refTable`/`refId` (+ `productCode` for
       payments) so taps can deep-link. *(List nesting under `payload` is
       confirmed; the FE handles both shapes.)*
3. [ ] 🔴 **Every `data` value is a string.** FCM requires it: `amount` →
       `"50000"`, all ids as strings.
4. [x] ✅ **`productCode` present on `commerce_payment`.** Confirmed in the list
       payload (`productCode: "wha4q5y88"`, a slug). The app routes payments to
       the **course audio player** by this code. Ensure the **push** payload
       includes it too.
5. [ ] Sending via **FCM HTTP v1** + service-account OAuth2 (legacy server key
       shut down 2024).
6. [ ] Tokens stored **per user, many-per-user** from `member/auth/devices`;
       **every** active token targeted.
7. [ ] `android.priority: high` + `apns-priority: 10`.
8. [ ] `android.notification.channel_id: "high_importance_channel"`.
9. [ ] Dead tokens pruned on `UNREGISTERED` (404) / `INVALID_ARGUMENT` (400).

**Verified in the list payload (2026-06-05):** deep-link fields nested under
`payload`; `refTable` values `post`/`comment`/`commerce_payment`; `productCode`
present on payments. `refId: null` on refunds is safe — the FE guards on empty
`refId`.

---

## How to test on a fresh build (avoids a false "regression")

FCM tokens change on **reinstall** — which `flutter install` does every time. So
a freshly installed build holds a **new** token that BE doesn't know yet.

1. Install the new build.
2. **Open it and log in once** — this runs `syncDeviceToken()` and registers the
   new token with BE.
3. *Then* trigger the event (like / comment / purchase).
4. Background or fully close the app and confirm the notification appears, and
   that tapping it lands on the right screen.

Skipping step 2 means BE pushes to the previous build's dead token → nothing
shows → looks like a regression but is just an unsynced token.

---

## Status

**FE — done on `feat/fcm-targeted-push` (verified on-device):**
- Token-refresh now re-registers (was an empty stub); registration centralized
  in `FCMService.syncDeviceToken()`.
- `FCMService.initialize()` now runs from `main()` (was splash-only → skipped
  for already-logged-in users, so onMessage/onBackgroundMessage/channel never
  registered). Idempotent; handlers register before channel setup.
- Two Android channels: `high_importance_channel` (heads-up, background/closed)
  and `foreground_channel` (low importance, quiet status-bar for foreground).
- Nested-`payload` parsing: `NotificationModel` (`readValue`) + push
  `_resolvePayload`. Deep-link routing by `payload.refTable`/`refId`:
  `post` → post detail, `comment` → comment detail, `commerce_payment` →
  **course audio player** (by `productCode`).
- Beranda fallback for broken/unknown/incomplete deep links.
- AndroidManifest: `POST_NOTIFICATIONS` + `default_notification_channel_id`.
- Verified on-device: foreground/background/closed display correctly; in-app +
  push taps route to post/comment/audio; broken → Beranda.

**FE — deferred:**
- Network notification deep-links (`network*` types) — display only until the
  join-request approval / network-detail screens are built.
- In-app list icons (`notification_page.dart`) only know `newPost`/`newComment`/
  `newLike`; new types (`newReply`, `tag`, payment, network) fall to the default
  icon. Cosmetic.
- Foreground-push live badge refresh (needs a notifier/stream; `MainCubit` isn't
  reachable from the root-navigator context).
- iOS prod `aps-environment` (needs per-configuration entitlements in Xcode;
  unverifiable on Windows).

**BE — to confirm:** that the **FCM push** payload mirrors the (verified) list
payload — same `payload` fields, all values as strings, `notification` block
present, high priority. The list side is confirmed; only the push side is
unverified (we can't inspect a live FCM message directly).
