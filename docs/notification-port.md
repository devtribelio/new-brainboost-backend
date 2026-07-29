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
| post publish | `post.service.ts` setelah `prisma.post.create` (status published) | **tidak ada listener** — direkap job harian, lihat §7 | `topicDigest` (21:00 WIB) |
| comment create (non-reply) | `comment.service.ts` create | comment.listener | `newComment`, `tag` (jika mentioned) |
| reply create | `reply.service.ts` create | comment.listener | `newReply`, `tag` |
| post-like create | `post.service.ts:169` like create | post.listener | `newLike` |
| comment-like create | `comment.service.ts:109` like create | comment.listener | `newLike` |
| network join-request | `network.service.ts` | network.listener | `requestJoin` (ke admin) |
| network approve | `network.service.ts` | network.listener | `approveJoin` (ke requester), `memberJoin` (ke creator) |
| commerce paid | `commerceEvents.on('commerce.payment.success')` (existing emit di `payment.service.ts:155`) | commerce.listener | `paymentSuccess` (buyer); `commissionEarned` (per affiliator) |

Idempotensi: dedupeKey unik. Re-emit (webhook redelivery, retries) silent-skip.

---

## 7. Recipient resolver

```ts
resolveForPost(post): memberIds         // NetworkMember of post.networkId, exclude author, exclude muted, exclude notificationsEnabled=false
resolveForComment(comment): memberIds   // postAuthor ∪ repliedCommentAuthor ∪ mentioned, exclude self, exclude muted post
resolveForNetwork(networkId, role?): memberIds   // 'admin' filter via NetworkMember.role; else all members
resolveForTopic(topicId, excludeMemberId?): memberIds  // TopicSubscription rows, exclude author, filterEnabled
```

### Topic recap harian 21:00 WIB (implemented 2026-07-29)

Post baru di topic **tidak** di-push saat kejadian. Sempat dibuat instan (listener `post.published`),
lalu diganti jadi rekap harian atas permintaan produk: satu push jam 21:00 WIB berisi
*"9 post baru di Topic A"*, bukan 9 push sepanjang hari.

Job: `packages/domain/src/jobs/topic-digest-notifications.ts`, terdaftar di `jobs-runner.ts` dan
ikut lane `bb-cron` (hourly) di `ecosystem.config.js`.

- **Jam kirim runtime-configurable**: `app_settings` key `notification.topicDigestHour` (0-23, WIB,
  default + fallback `DIGEST_HOUR_WIB`=21, di-seed `pnpm seed:settings`). Nilai non-integer atau di
  luar 0-23 di-log warn lalu jatuh ke default — salah ketik tidak boleh membuat job mengirim di jam
  acak. Ubah jam = update satu baris DB, tanpa deploy (propagasi ≤ TTL cache settings 30 detik;
  job one-shot selalu baca fresh).
- **Window tetap 24 jam** berakhir pada jam cutoff hari itu → antar-hari tidak pernah overlap. Post
  jam 21:05 masuk rekap besok.
- **Self-guarding pada jam WIB**, bukan pada jam pemicu. Ini disengaja: **tidak ada TZ yang dipin
  di repo ini** (`ecosystem.config.js` tanpa TZ, tidak ada Dockerfile TZ) dan PM2 mengevaluasi
  `cron_restart` pakai waktu lokal daemon. Job no-op sebelum boundary, jadi tick hourly tetap
  mengirim tepat jam 21:00 WIB apa pun TZ server. Tick yang bolong tidak menggandakan apa pun.
- **Idempoten per hari WIB** lewat `dedupeKey = topicDigest:<hari>:<topicId>:<memberId>` (kolom
  UNIQUE). Run kedua di hari yang sama → nol row, nol push.
- **Row per topic, push sekali.** Feed tetap granular (tiap baris deep-link ke topic-nya) tapi FCM
  digabung: >1 topic → *"12 post baru di 2 topic yang kamu ikuti"*. Karena itu producer punya
  `skipPush` — row ditulis tanpa push, push dikirim sekali di akhir per member.
- Hitungan mengecualikan post si member sendiri, `isDeleted`, dan non-published; mute dihormati
  pada scope `topic` **dan** `network` induk. Scope `topic` masuk allow-list `POST /notification/mute`.
- `runConcurrent` (limit `DIGEST_CONCURRENCY`=10) menahan spike jam 21:00 — `sendToMember` loop
  per device dan tidak ada multicast, jadi fan-out tanpa batas akan menghantam pool DB + FCM.

#### Pengiriman push: outbox → SQS → worker

Job **tidak** memanggil FCM langsung saat queue tersedia. Alurnya:

```
topicDigestNotifications (job 21:00)
  └─ $transaction([ ...notification rows, notification_outbox row (channel='fcm') ])
       ↓
bb-push-relay  (apps/mobile-api/src/workers/push-relay.ts)
  └─ poll PENDING channel='fcm' → publishPush() → SQS notif-push → status SENT
       ↓
bb-push-worker (apps/notification-worker)
  └─ long-poll → claim push_idempotency → fcmService.sendToMember → delete message
```

- **Row feed + job push commit bersama** dalam satu `$transaction`. Ini menutup lubang durabilitas
  desain sebelumnya: dulu kalau job crash setelah row ditulis tapi sebelum push, run berikutnya kena
  dedupe lalu melewati push-nya → push hilang permanen. Sekarang crash = tidak ada yang tertulis,
  run berikutnya mengulang member itu. Ada tes yang memaksa insert outbox gagal dan memastikan
  row feed ikut ter-rollback.
- **Outbox-nya tabel yang sudah ada** (`notification_outbox`) — kolom `channel` memang sudah
  didokumentasikan menampung `'fcm'` sejak awal. Konsekuensinya `comms-relay` **wajib** di-scope ke
  `COMMS_CHANNELS`; tanpa itu ia akan mempublish baris push ke queue comms dan bb-comms menerima
  kerjaan yang tidak bisa ia kirim.
- **Queue terpisah** `notif-push` (bukan `comms-*`): fan-out rekap yang bursty tidak boleh mengantre
  di depan OTP. Relay-nya pun proses sendiri (`bb-push-relay`) dengan alasan yang sama.
- **Idempotensi consumer**: SQS Standard at-least-once, jadi worker meng-*claim* `messageId` di
  tabel baru `push_idempotency` (PK) **sebelum** memanggil FCM. Redelivery kena PK → di-skip.
  Claim diambil sebelum kirim, bukan sesudah: push dobel lebih buruk daripada satu yang hilang,
  dan baris outbox tetap menjadi catatan bahwa ia pernah di-queue.
- **Poison message** (kontrak beda versi / body tidak terparse) dihapus, tidak di-retry — ia tidak
  akan pernah sukses dan hanya menghabiskan jatah redrive. Kegagalan FCM sebaliknya di-*throw*
  supaya SQS redeliver lalu redrive ke DLQ.
- **Fallback tanpa queue**: kalau `SQS_NOTIF_PUSH_URL` kosong, job kembali mengirim in-process
  (perilaku lama). Jadi dev dan periode sebelum queue di-provision tetap jalan.
- **Scaling**: relay `instances:1` (masih plain PENDING→SENT flip, belum `FOR UPDATE SKIP LOCKED`).
  Worker **aman di-scale out** — klaim via visibility timeout + PK `push_idempotency`.

**Belum dikerjakan (di luar repo):** provisioning queue `notif-push` + DLQ/redrive via IaC, IAM
untuk producer (SendMessage) dan consumer (ReceiveMessage/DeleteMessage), lalu isi
`SQS_NOTIF_PUSH_URL`. Sampai itu ada, jalur fallback yang aktif.

Konsekuensi: `post.published` sekarang **tidak punya listener sama sekali** (job baca tabel `posts`
langsung). Event-nya sengaja dipertahankan beserta field `topicId`-nya.

**Butuh dukungan mobile:** type `topicDigest` adalah label baru. Serializer meneruskan `type` +
`payload` apa adanya; `payload` berisi `refTable:'topic'`, `refId`, `topicId`, `postCount`,
`digestDay`. Kalau FE me-route berdasar `refTable` maka tap-through sudah jalan; kalau me-`switch`
berdasar `type`, `topicDigest` harus ditambahkan di sisi app.

Legacy tidak pernah mengirim `newPost` (`ACTION_LABEL_NEW_POST` di `TBNotification.php` cuma
dideklarasikan, nol call-site), jadi ini fitur baru, bukan paritas.

Query single round-trip per resolve (Prisma `findMany select: {memberId}` + `where notificationsEnabled: true`).

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
