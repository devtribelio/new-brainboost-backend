# Notification Port Plan

Plan port notification dari legacy (`tribelio-platform`) ke `bb-backend-new` dengan simplifikasi schema + logic. Read API sudah ada di `src/modules/notification/`; yang belum: **producer (write-side) + push delivery**.

---

## 1. Legacy reference

- Producer in-app: `TBModel/Member.php:723 createNotification($attributes)` — tulis row `TBModel_Notification` dengan field `(member_id, network_id, network_account_id, ref_table, ref_id, title, message, action_label, is_notification_page|account|brainboost)`.
- Producer push: `TBPushNotification::send(EngineClass, $id)` (`TBPushNotification.php:19`) → dispatch ke `PushNotifQueue` worker. ~40 engine class di `libraries/TBPushNotification/Engine/`, masing-masing: load aggregate → recipient query → loop `createNotification` + FCM payload.
- Setting filter pakai 3 tabel: `network_member_setting` (per-user, ∈ `off|tribe_team|all|tagged`), `network_setting_pushnotification` (chief toggle), `member_notification_post` (mute thread).
- Action label constants: 35+ di `TBNotification.php:4-70`.

---

## 2. Existing in new repo

- `prisma/schema.prisma:643` model `Notification(id, memberId, networkId?, type, notifGroup?, title, body?, payload Json?, url?, seenAt, readAt, createdAt)` — sudah cukup minimal.
- `prisma/schema.prisma:93` model `Device(memberId, deviceId, platform, fcmToken)`.
- Read API: `GET /notification/list`, `POST /notification/seen` (`src/modules/notification/`).
- Event bus pattern terbukti: `src/common/events/commerce-events.ts` + `src/modules/commerce/listeners/payment-success.listener.ts`.

---

## 3. Simplifikasi vs legacy

| Aspek legacy | Aksi | Pengganti |
|---|---|---|
| `network_account_id`, `is_notification_account/page/brainboost` | drop | single-tenant, `notifGroup` enum existing |
| 3 setting tables (`network_member_setting`, `network_setting_pushnotification`, `member_notification_post`) | drop fase-1 | `Member.notificationsEnabled` global + `NotificationMute` (fase-5) |
| `PushNotifQueue` + worker | drop | fire-and-forget `setImmediate`; queue datang nanti kalau scale |
| 40 Engine class | konsolidasi | 1 `NotificationProducer` + 1 `RecipientResolver` + listener per modul |
| `getLinkUrl` server-side | drop | mobile route via `type` + `payload.refTable/refId` |
| 35+ action label constants | pangkas | enum 10: `newPost, newComment, newReply, newLike, tag, requestJoin, approveJoin, memberJoin, paymentSuccess, commissionEarned` |
| Mentions parse inline per-engine | helper | `extractMentions(post|comment)` |

---

## 4. Schema delta

```prisma
model Notification {
  // existing fields unchanged
  dedupeKey  String?  @unique           // tambah; format `${type}:${refId}:${memberId}`
  @@index([memberId, seenAt])           // tambah; badge unread cepat
}

model Member {
  notificationsEnabled  Boolean  @default(true)   // tambah
}

// Fase-5 (opsional):
model NotificationMute {
  memberId  String  @db.Uuid
  scope     String                  // 'post' | 'network'
  refId     String  @db.Uuid
  createdAt DateTime @default(now())
  @@id([memberId, scope, refId])
  @@map("notification_mutes")
}
```

Tidak rename kolom `type` (hindari breaking read API existing).

---

## 5. Arsitektur

```
src/common/events/
  notification-events.ts            # TypedEmitter (pola sama dengan commerce-events.ts)

src/modules/notification/
  action-labels.ts                  # const ActionLabel = {...}; type ActionLabel = ...
  notification.producer.ts          # createForMember, createForMany (transactional)
  recipient.resolver.ts             # resolveForPost, resolveForComment, resolveForNetwork
  fcm.service.ts                    # HTTP v1 multicast; UNREGISTERED → delete Device
  listeners/
    register.ts                     # registerNotificationListeners()
    commerce.listener.ts            # piggyback existing commerceEvents
    post.listener.ts
    comment.listener.ts
    network.listener.ts
  notification.service.ts           # existing read API — unchanged
  notification.controller.ts        # existing — unchanged (fase-5 tambah mute/unmute)
```

Kontrak `NotificationProducer.createForMember`:
```ts
createForMember(input: {
  memberId: string;
  type: ActionLabel;
  networkId?: string;
  title: string;
  body?: string;
  payload?: { refTable?: string; refId?: string; [k: string]: unknown };
  url?: string;
  dedupeKey?: string;
}): Promise<Notification | null>   // null kalau P2002 (dedupe skip) atau member.notificationsEnabled=false
```

Setelah row tertulis: `setImmediate(() => fcm.dispatch(memberId, ...))` — tidak `await` untuk hindari block request.

---

## 6. Hook points

| Event modul | Emit di | Listener | Action label |
|---|---|---|---|
| post publish | `post.service.ts` setelah `prisma.post.create` (status published) | **topic.listener** | `newPost` → semua subscriber `topic_subscriptions`, kecuali author. No-op kalau `topicId` null. Fan-out di-slice 200/chunk (subscriber tidak terbatas, beda dari network team). Post di network tanpa topic **belum** punya fan-out. |
| comment create (non-reply) | `comment.service.ts` create | comment.listener | `newComment`, `tag` (jika mentioned) |
| reply create | `reply.service.ts` create | comment.listener | `newReply`, `tag` |
| post-like create | `post.service.ts:169` like create | post.listener | `newLike` |
| comment-like create | `comment.service.ts:109` like create | comment.listener | `newLike` |
| network join-request | `network.service.ts` | network.listener | `requestJoin` (ke admin) |
| network approve | `network.service.ts` | network.listener | `approveJoin` (ke requester), `memberJoin` (ke creator) |
| commerce paid | `commerceEvents.on('commerce.payment.success')` (existing emit di `payment.service.ts:155`) | commerce.listener | `paymentSuccess` (buyer); `commissionEarned` (per affiliator) |

Idempotensi: dedupeKey unik. Re-emit (webhook redelivery, retries) silent-skip.

### Mute (diperbaiki 2026-08-03)

Scope valid: **`post` | `topic` | `network`** — satu sumber di `notification/mute-scope.ts`
(`MuteScope`, `assertMuteScope`, `resolveMuteRefId`), dipakai `mute()` **dan** `unmute()`.
Sebelumnya: `unmute` tidak memvalidasi scope sama sekali (typo = no-op yang terlihat sukses),
`mute` melempar `Error` polos → 500 bukan 400, dan controller menduplikasi daftar scope.

`notification_mutes.ref_id` bertipe `@db.Uuid` tapi FE mengirim legacyId int seperti di
endpoint lain → `resolveMuteRefId` menerjemahkan int→UUID (404 kalau tidak ketemu,
400 kalau bukan int maupun UUID). Tanpa ini int mentah sampai ke Prisma → P2023 → 500.

`filterNotMuted` dulu hanya dipanggil `comment.created`. Sekarang dipasang juga di
`post.liked`, `comment.liked` (resolve scope lewat post induk komentar), dan ketiga
handler network. **Commerce sengaja tidak** — `paymentSuccess`/`commissionEarned`
transaksional, mute post/topic/network tidak boleh meredamnya.

Untuk `newPost` scope `post` tidak dipakai: post-nya baru lahir, mustahil sudah di-mute.

---

## 7. Recipient resolver

```ts
resolveForPost(post): memberIds         // NetworkMember of post.networkId, exclude author, exclude muted, exclude notificationsEnabled=false
resolveForComment(comment): memberIds   // postAuthor ∪ repliedCommentAuthor ∪ mentioned, exclude self, exclude muted post
resolveForNetwork(networkId, role?): memberIds   // 'admin' filter via NetworkMember.role; else all members
```

Query single round-trip per resolve (Prisma `findMany select: {memberId}` + `where notificationsEnabled: true`).

---

## 7b. Push fatigue — unopened push limit (2026-08-03)

Member yang tidak kunjung membuka app berhenti diberi push setelah N kali. **Yang ditahan
hanya pengiriman FCM** — baris `notifications` tetap ditulis, jadi begitu app dibuka
daftarnya lengkap. Gerbangnya di `NotificationProducer.claimPushSlot`, dipanggil dari
`dispatchPush` (satu-satunya jalur push).

- **Counter:** `members.unopened_push_count` (Int, default 0, migrasi
  `20260803150000_add_unopened_push_count`). Per member, bukan per device — aturan
  single-active-device di `registerDevice` sudah memastikan hanya satu device
  memegang `fcmToken`.
- **Ambang:** `app_settings` key `notification.unopenedPushLimit`
  (`SETTING_KEYS.notificationUnopenedPushLimit`), fallback `UNOPENED_PUSH_LIMIT_DEFAULT`=**0**.
  **`0` = gerbang mati tapi counter tetap jalan** — ini mode rilis awalnya, supaya
  distribusi nyatanya bisa diukur dari log (`unopenedPushCount` ikut di baris
  `[notification] push firing`) sebelum dinyalakan. Naikkan ke `3` lewat DB, efektif
  ≤30 detik (`CACHE_TTL_MS`), tanpa deploy — sekaligus tombol darurat.
- **Reset (re-arm) — SETIAP request ber-auth member.** `resetUnopenedPushCount`
  (`packages/common/src/utils/member-activity.util.ts`) dipanggil dari `authGuard`,
  `optionalAuthGuard` + `anonOrMemberGuard` (hanya saat scope `member`). Throttle
  in-process 60 detik, `updateMany` bersyarat (`unopenedPushCount > 0`) supaya member
  yang sudah 0 tidak menulis apa pun, fire-and-forget. Dua titik lama tetap ada:
  `MemberService.findById({touchActivity:true})` ← `/member/info` dan
  `NotificationService.markSeen`.
  **Jangan pernah menambahkan `lastActiveAt` ke hook ini** — pemicu re-KYC dormant
  (`member.service.ts`) justru butuh kolom itu MASIH menyimpan stempel sesi
  sebelumnya saat `/member/info` jalan; itulah ukuran lama menganggurnya. Menyegarkan
  per request akan membuat jaraknya nol dan mematikan re-KYC dormant tanpa error.
  `authGuardLenient` sengaja TIDAK ikut: endpoint-nya dipakai saat member justru
  meninggalkan sesi (logout cleanup).
- **Menembus batas tanpa menaikkan counter:** `paymentSuccess`, `paymentPending`,
  `paymentRefunded`, `subscriptionRenewed`, `commissionEarned` (`PUSH_LIMIT_EXEMPT`).
  Alasan sama dengan commerce yang dikecualikan dari mute.
- **Konkurensi:** `update({ data: { increment: 1 } })` mengembalikan nilai pasca-increment,
  jadi dua notifikasi bersamaan tidak bisa sama-sama melihat hitungan yang sama.
  Read-then-write akan meloloskan keduanya.
- **Fail open:** kalau pengecekan budget error, push tetap dikirim.

**Kenapa reset diperlebar (2026-08-04).** Versi pertama hanya mereset di `/member/info`.
Tim FE mengonfirmasi endpoint itu **hanya dipanggil saat cold start**, tidak saat app
kembali dari background — jadi member yang rajin mengangkat app dari background tidak
pernah reset dan akan bungkam permanen setelah N push, persis kebalikan dari tujuan
fiturnya. `lastActiveAt` tidak bisa dipakai sebagai penyelamat karena ditulis oleh
endpoint yang sama, jadi sama basinya. Karena itu sinyal kehadiran diambil dari request
apa pun yang ber-auth — tidak perlu rilis klien. Ini sekaligus menutup kasus member yang
sedang DI DALAM app lalu menerima >N notifikasi: dia pasti sedang memanggil API, jadi
counter-nya ikut ter-reset.

**Masih terbuka:** sinyal foreground eksplisit dari FE tetap lebih baik, dan
cold-start-only juga berarti `lastActiveAt` sendiri tidak akurat untuk keperluan lain
(mis. ukuran dormansi re-KYC lebih longgar dari kenyataan). Butuh rilis klien.

---

## 8. Fase + acceptance

| Fase | Deliverable | Acceptance |
|---|---|---|
| 1 | Schema migration + producer + resolver + commerce listener | `pnpm prisma:migrate` clean; `commerce.payment.success` → 1 row `Notification` untuk buyer; dedupe re-emit; `pnpm test` smoke green |
| 2 | post/comment/reply/like listener + mentions | publish post di network N → semua member N (kecuali author) dapat row; comment di post P → author P + mentioned dapat row; tag pakai action `tag` |
| 3 | network join-request/approve/memberJoin | request → admin notif; approve → requester + creator notif |
| 4 | FCM v1 service + push dispatch | row tertulis + FCM dipanggil dengan `{title, body, data:{type, refId}}`; invalid token cleanup |
| 5 (opt) | NotificationMute table + endpoint | mute post → no row dibuat untuk muted member |
| QA | Tests integration | producer dedupe; resolver exclude muted; commerce → row |

---

## 9. Out of scope

- Email notification (legacy `NotificationEmailQueue`). Existing repo punya mailer service, namun email-notification campaign ≠ in-app notification; tunda.
- Chat/broadcast queue (`NotificationChatQueue`, `NotificationWhatsappQueue`, `NotificationKataaiQueue`, `NotificationQontakQueue`). Tidak port — chat dipertimbangkan drop di `CLAUDE.md §7`.
- Web admin notification (`NotificationAccount` + `TBNotification_Account_Method_*`). Mobile-only scope.
- Per-network granular setting UI. Drop sampai user nyata minta.
- `creator_notification` legacy table (`CreatorNotification.php`) — duplikasi web admin.

---

## 10. Risiko

- **FCM v1 credential setup**: butuh service account JSON dari Firebase console; env baru `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON`. Tanpa ini, fase-4 stub-only.
- **Recipient fan-out 10k member network**: `findMany select memberId` lalu loop `createForMember` = 10k insert. Mitigasi: `createMany` batch + manual dedupe pre-check, atau `INSERT ... ON CONFLICT`. Tinjau ulang sebelum fase-2 merge jika ada network besar di legacy data.
- **Re-emit storm**: idempotensi dedupeKey wajib — kalau lupa, satu webhook retry = N duplikat.
- **Mute table growth**: kalau fase-5 dipakai, perlu prune ketika post/network di-soft-delete.

---

## 11. Tracking

Status modul di `CLAUDE.md §7` saat ini: `[x] notification — list, read`. Setelah port: update jadi `[~] notification — read API done; producer + FCM in progress`, lalu `[x]` setelah fase-4 lulus QA.

Update `docs/rewrite-progress.md` per fase.

---

## 12. Future: RabbitMQ queue (TIDAK diimplementasi sekarang)

Saat ini producer pakai `setImmediate` fire-and-forget untuk dispatch FCM. Single-instance OK. **Tidak port sekarang** — catat di sini supaya tahu cut-over point ketika butuh.

### Kapan ganti ke RabbitMQ

Trigger migrasi:
- Multi-instance backend (horizontal scale) — `setImmediate` per-instance hilang kalau process restart mid-dispatch.
- FCM batch besar (>500 token per event) — perlu rate-limit ke quota Firebase (≈600 req/min/project).
- Retry policy untuk FCM 5xx — `setImmediate` tidak retry.
- Email/SMS/WA channel ditambahkan — multi-channel fan-out lebih bersih lewat queue.
- SLA delivery (notif "must arrive") — perlu persistence di luar process memory.

Sampai semua di atas tidak relevan, **tetap pakai `setImmediate`**. Jangan over-engineer.

### Arsitektur target (RabbitMQ)

```
Producer (notification.producer.ts)
  → prisma.notification.create (DB row, source of truth)
  → rabbitmq.publish('notif.fcm', { notificationId, memberId, payload }) 
       [pengganti setImmediate(...)]

Worker (separate process: src/workers/notification-fcm.worker.ts)
  ← consume 'notif.fcm'
  → fcm.sendToMember(...)
  → ack on success | nack + DLQ on 5xx setelah N retry
```

Exchange: topic `notifications`. Routing key per-channel: `notif.fcm`, `notif.email`, `notif.ws` (kalau ada WebSocket push).

DLQ: `notifications.dlq` untuk pesan gagal terus — di-replay manual atau di-monitor.

### Schema delta (saat migrasi nanti)

Opsi A — tabel outbox (preferred, hindari dual-write race):
```prisma
model NotificationOutbox {
  id             String   @id @default(uuid(7)) @db.Uuid
  notificationId String   @db.Uuid
  channel        String   // 'fcm' | 'email' | 'ws'
  status         String   @default("PENDING")  // PENDING | SENT | FAILED
  attempts       Int      @default(0)
  lastError      String?
  scheduledAt    DateTime @default(now())
  sentAt         DateTime?
  createdAt      DateTime @default(now())

  @@index([status, scheduledAt])
  @@map("notification_outbox")
}
```

Producer commit: `prisma.$transaction([notification.create, outbox.create])` di transaction sama → publisher daemon poll PENDING, push ke RabbitMQ. Tidak ada race antara DB commit dan queue publish.

Opsi B — direct publish dari producer setelah `prisma.notification.create` sukses. Lebih simple, tapi ada window kecil (DB commit OK, publish fail) yang bisa kehilangan dispatch. Mitigasi: subscriber periodic scan `notification.id where createdAt > now()-5m and not in outbox`.

**Rekomendasi:** Opsi A. 1 extra table, 0 race.

### Dependency baru (nanti)

```
amqplib                         # AMQP 0-9-1 client
@types/amqplib                  # dev
```

Env baru:
```
RABBITMQ_URL=amqp://user:pass@host:5672/vhost
NOTIF_FCM_QUEUE=notif.fcm
NOTIF_FCM_DLQ=notif.fcm.dlq
NOTIF_FCM_MAX_RETRIES=5
```

### Migration steps (saat eksekusi)

1. Tambah `NotificationOutbox` table.
2. Wrap `producer.createForMember` dalam transaction yang juga tulis outbox row.
3. Buat `src/workers/notification-publisher.ts` (daemon): poll outbox PENDING → publish AMQP → mark SENT.
4. Buat `src/workers/notification-fcm.worker.ts` (daemon): consume `notif.fcm` → `fcm.sendToMember` → ack/nack.
5. Hapus `dispatchPush` setImmediate dari producer (move logic ke worker).
6. Update `process` runner: spawn 2 worker proses (publisher + consumer) selain web app.

### Risiko migrasi

- Worker proses baru = infra change (Procfile/docker-compose tambah service).
- Outbox table growth → cron prune `SENT older than 7 days`.
- Ordering tidak guaranteed antar event (RabbitMQ FIFO per-queue, tapi fanout parallel). Sebagian besar notifikasi tidak butuh urutan, namun verify per-use-case.
- Backpressure: publisher daemon harus rate-limit kalau outbox menumpuk.

### Catatan implementasi

- Existing `commerceEvents` TypedEmitter tetap dipakai untuk in-process bus (post→listener). Cuma dispatch FCM yang ke queue.
- Producer interface tidak berubah → caller code (listener) tidak perlu disentuh.
- Test setup: kalau worker test perlu, pakai `amqplib-mocks` atau spin RabbitMQ container di CI.
