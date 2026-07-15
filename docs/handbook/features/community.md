# Community — Topic, Post, Comment, Reply, Network & Report

[⬅ Kembali ke index](../README.md)

## Overview

Fitur sosial/komunitas aplikasi: member bergabung ke **network** (komunitas/tribe), berdiskusi lewat **topic**, menulis **post** di feed, saling **comment** dan **reply**, memberi like, serta melaporkan konten atau member yang bermasalah (**report**). Ini porting dari controller `topic.php`, `post.php`, `network.php` + library `TBPost`/`TBComment`/`TBNetwork`/`TBReport` legacy — path endpoint sengaja mengikuti kontrak mobile client lama, bukan REST ideal.

Enam modul HTTP terlibat, semuanya prefix `/api/member`:

- Kode HTTP: `apps/mobile-api/src/modules/{topic,post,comment,reply,network,report}/`
- Service bersama (dipakai lintas app): `packages/domain/src/post/post.service.ts` + `packages/domain/src/comment/comment.service.ts`; sisanya service lokal modul

## Endpoint

Semua di bawah `/api/member`. `optionalAuthGuard` = boleh anonim, tapi kalau ada JWT dipakai untuk personalisasi (mis. flag `isLiked`/`isSubscribed`).

### Topic

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| GET | `/api/member/topic/list` | Opsional | Daftar topik (+ status subscribe kalau login) |
| POST | `/api/member/topic/subscribe` | JWT | Subscribe/unsubscribe topik |

### Post

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| GET | `/api/member/post/list` | JWT | Feed post (paginated) |
| GET | `/api/member/post/detail` | JWT | Detail satu post |
| POST | `/api/member/post/create` | JWT | **Create sekaligus update** (satu endpoint, kontrak legacy) |
| POST | `/api/member/post/like` | JWT | Toggle like post |
| POST | `/api/member/post/delete` | JWT | Hapus post (soft-delete) |
| POST | `/api/member/post/report` | JWT | Laporkan post |

### Comment

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| GET | `/api/member/comment/list` | Opsional | Daftar komentar sebuah post |
| GET | `/api/member/comment/detail` | Opsional | Detail satu komentar |
| POST | `/api/member/comment/create` | JWT | Buat komentar (atau reply, via `parentId`) |
| POST | `/api/member/comment/update` | JWT | Edit komentar |
| POST | `/api/member/comment/like` | JWT | Toggle like komentar |
| POST | `/api/member/comment/delete` | JWT | Hapus komentar (soft-delete) |

### Reply

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| GET | `/api/member/reply/list` | Opsional | Daftar reply dari sebuah komentar |

> Reply **bukan entitas sendiri** — reply = row `comments` dengan `parent_id` terisi (self-reference). Modul reply hanya menyediakan listing; create reply lewat `/comment/create`.

### Network

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| POST | `/api/member/network/join` | JWT | Join network (langsung member, atau jadi request kalau network private) |
| POST | `/api/member/network/request/approve` | JWT | Approve request join (tim/moderator) |
| POST | `/api/member/network/request/reject` | JWT | Reject request join |
| GET | `/api/member/network/member` | JWT | Cari member network — **input kosong = list SEMUA member** (lihat business rules) |
| GET | `/api/member/network/tag` | JWT | Daftar tag network |

### Report

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| GET | `/api/member/report/category` | Publik | Daftar kategori laporan |
| POST | `/api/member/report/memberReport` | JWT | Laporkan member lain |

## Tabel database

| Tabel | Peran di fitur ini |
|---|---|
| `topics` | Topik diskusi; bisa milik network (`network_id`), `type` PUBLIC/privat |
| `topic_join_requests` | Request join topik non-publik (status PENDING/APPROVED/REJECTED/CANCELLED) |
| `topic_subscriptions` | Subscribe member↔topik, unique per pasangan |
| `posts` | Post feed; counter denormalisasi (`count_like`, `count_comment`, `count_replies`), flag kurasi (`is_pinned`, `is_curated`, `is_admin_post`), soft-delete `is_deleted` |
| `post_likes` | Like post, unique (post, member) |
| `post_reports` | Laporan atas post (kategori + status review) |
| `comments` | Komentar **dan** reply (self-ref `parent_id`); counter + soft-delete seperti post |
| `comment_likes` | Like komentar, unique (comment, member) |
| `networks` | Komunitas/tribe; `count_member` denormalisasi, `is_public`, `purpose` (timeline/education) |
| `network_members` | Keanggotaan; `is_muted` = mute per-network (lihat business rules) |
| `network_member_requests` | Request join network private |
| `network_banned_members` | Member yang di-ban dari network |
| `network_team_members` | Tim moderator per network |
| `network_tags` | Tag/label network |
| `report_categories` | Master kategori laporan (dipakai post report & member report) |
| `member_reports` | Laporan member → member |

## Business rules

1. **`/network/member` dengan `input` kosong = list SEMUA member network** — bukan bug: parity perilaku tag-filter legacy (commit `95a40c2`). Konsekuensinya endpoint ini **wajib di belakang `authGuard`** — tanpa itu dia jadi full member dump berisi PII (pernah terjadi, sudah ditutup; minimisasi field PII di serializer masih menunggu koordinasi FE).
2. **Mute per-network** — `network_members.is_muted` (di-set tim/admin) membisukan member di network itu tanpa mengeluarkannya: **memblok create post, comment, dan like**. Mirror `TBApi::validateMemberMuteNetwork` legacy. Terpisah dari `members.is_muted` yang global.
3. **Soft-delete + counter denormalisasi** — post/comment tidak pernah dihapus fisik (`is_deleted=true`), dan jumlah like/comment disimpan sebagai kolom counter di row induk (di-increment/decrement saat aksi) demi feed cepat tanpa agregasi. Konsistensi counter dijaga di service, bukan trigger DB.
4. **Reply = comment dengan `parent_id`** — hierarki komentar satu level via self-reference; `count_replies` di komentar induk ikut di-maintain.
5. **`/post/create` melayani create dan update** — satu endpoint untuk dua operasi, mengikuti kontrak mobile client legacy. Jangan "diperbaiki" jadi PUT terpisah.
6. **Join network** — network publik: langsung jadi `network_members`; network private: masuk `network_member_requests` dan menunggu approve tim. Member yang ada di `network_banned_members` ditolak.

## Events

Semua event dikonsumsi listener notifikasi (feed in-app + FCM push); lihat [01 — Arsitektur §6](../01-architecture.md#6-event-bus-in-process).

| Arah | Nama | Pemicu |
|---|---|---|
| Emit | `post.published` | post baru terbit |
| Emit | `post.liked` | like post |
| Emit | `comment.created` | komentar/reply baru |
| Emit | `comment.liked` | like komentar |
| Emit | `network.member.requested` | request join network private |
| Emit | `network.member.joined` | member masuk network |
| Emit | `network.member.approved` | request join di-approve |

## Referensi

- Pemetaan simbol legacy → baru: [`docs/specs/legacy-analysis.md`](../../specs/legacy-analysis.md)
- Notifikasi yang dihasilkan event di atas: halaman notification *(menyusul)* — sementara [`docs/specs/notification-port.md`](../../specs/notification-port.md)
- Skema tabel: [02 — Database §2.5](../02-database.md#25-community-16)
