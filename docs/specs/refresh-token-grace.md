# Refresh token grace window + supersession lineage

Fix for "sesi berakhir tiba-tiba" — users logged out at random with a session
that was still valid. PRD: [Confluence — PRD Fix Sesi Berakhir Tiba-tiba](https://tribelio.atlassian.net/wiki/spaces/TRIBELIO/pages/792166401/).

Implemented 2026-08-03. Backend only, no client change, no endpoint change.

---

## 1. The bug

Session liveness is checked against the DB on **every** request: the access
token carries `sid` = `refresh_tokens.id`, and `authGuard` → `assertSessionActive`
401s if that row is missing or has `revoked_at` set. Rotation on
`grant_type=refresh_token` revoked the caller's row **instantly**, with nothing
recording that a successor existed.

So `revoked_at` alone had to mean four different things, and the code treated
them identically:

| Why `revoked_at` was set | What should happen |
|---|---|
| rotated by a successful refresh | **nothing** — this is the happy path |
| user logged out | end the session, now |
| password changed | end the session, now |
| kicked by a login on another device | end the session, now |

Three failure modes followed, all of which surfaced as a forced logout:

1. **Parallel refresh** — several requests 401 at once, the client fires refresh
   more than once. The first rotates and revokes; the second arrives holding the
   now-revoked token → `SESSION_REVOKED`.
2. **Rotation tail** — after a successful refresh, requests already in flight
   still carry the pre-rotation access token. Its JWT is nowhere near expiry, but
   its `sid` is revoked → 401.
3. **Lost response** — the server rotated, but the response never reached the
   client (timeout). The client keeps the old token and is kicked on its next
   attempt. **This one needs no app-kill and no concurrency**; on Indonesian
   mobile networks it is routine.

## 2. The fix

One nullable column, `refresh_tokens.superseded_by_id`, holding the `id` of the
row that replaced this one. It is written **only** by rotation.

That asymmetry is the entire safety argument. Logout, password change and the
single-session kick all revoke *without* a successor, so they are still terminal
and still instant. Grace attaches to exactly one cause — rotation — which is the
one that was never supposed to end a session in the first place.

```
id      revoked_at            superseded_by_id   meaning
------  --------------------  -----------------  ---------------------------
…aa     2026-08-03 10:00:00   …bb                rotated → replayable in window
…bb     2026-08-03 10:15:00   …cc                rotated → replayable in window
…cc     NULL                  NULL               the live session
…dd     2026-08-03 11:00:00   NULL               logged out → terminal
```

`REFRESH_GRACE_SECONDS` (default **60**) is how long a rotated row keeps
answering. 60s covers a lost refresh response on a flaky connection. It is
boot-time config like everything else in `env.ts` — change it via the secret plus
`--force-new-deployment`, **not** at runtime.

### 2.1 Refresh branches

`AuthService.loginWithRefreshToken`, after signature verification and row lookup:

| # | Condition | Result |
|---|---|---|
| 1 | not found / bad signature | 401 `REFRESH_TOKEN_INVALID` |
| 2 | revoked, in grace, `supersededById` set | **grace replay** — successor's refresh token + a fresh access token for `sid = successor.id` |
| 3 | revoked, out of grace **or** no successor | 401 `SESSION_REVOKED` |
| 4 | `expires_at` passed | 401 `REFRESH_TOKEN_EXPIRED` |
| 5 | live | rotate (below); losing the gate falls to branch 2 |

**Branch 2 is checked before branch 4 deliberately.** A row rotated shortly
before its own 30-day expiry would otherwise answer `REFRESH_TOKEN_EXPIRED`
during the window in which it is legitimately replayable — the same false logout
wearing a different error code.

Grace replay creates **no row**, so replaying N times is idempotent and returns
the same pair every time.

### 2.2 Forward walk

Branch 2 follows the `superseded_by_id` chain up to `MAX_SUPERSESSION_HOPS` (5)
until it finds a live row. A client can legitimately be more than one generation
behind: the winner refreshes again while the loser is still retrying. Without the
walk, that client is kicked despite the grace window. The bound is there because
anything deeper than a couple of hops means corrupt data, not a slow client.

### 2.3 Concurrency gate

Two parallel refreshes could both observe the row un-revoked and both mint a
child. `rotateRefreshToken` closes that with a conditional update **inside** an
interactive transaction:

```ts
const gate = await tx.refreshToken.updateMany({
  where: { id: oldTokenId, revokedAt: null },
  data:  { revokedAt: new Date(), supersededById: tokenId },
});
if (gate.count === 0) throw new RotationLostError();
await tx.refreshToken.create({ data: { id: tokenId, … } });
```

The loser blocks on the winner's row lock and, under READ COMMITTED,
re-evaluates the predicate once the winner commits — matching 0 rows. Because it
is all one transaction, losing costs nothing: the child insert never runs, so no
orphan session row is left behind.

Two implementation details that are easy to get wrong:

- **The loser must re-read the row *after* the gate.** Reading `supersededById`
  any earlier can see `null` and 401 the exact request this change exists to
  save.
- **`superseded_by_id` is a plain scalar, no FK.** The gate writes the pointer
  before the child row exists. Adding a real FK later means restructuring the
  gate, not just the schema. The `UNIQUE` index is kept as a second line of
  defence — a double rotation would collide with P2002.

### 2.4 authGuard

`assertSessionActive` applies the same rule: a revoked row still passes while
`supersededById` is set and `revoked_at` is within the window. This is what
closes failure mode 2 (rotation tail) — that path never touches `AuthService`,
so the grace logic in the refresh endpoint alone would not have covered it.

## 3. Behaviour change

Only ever 401 → 200. Nothing that used to succeed now fails.

| Scenario | Before | After |
|---|---|---|
| live refresh token | 200 rotate | same |
| unknown / tampered token | 401 `REFRESH_TOKEN_INVALID` | same |
| expired token | 401 `REFRESH_TOKEN_EXPIRED` | same |
| revoked by logout / password change / kick | 401 `SESSION_REVOKED` | same |
| rotated, replayed after the window | 401 `SESSION_REVOKED` | same |
| **rotated, replayed inside the window** | 401 `SESSION_REVOKED` | **200** |
| **access token whose `sid` was just superseded** | 401 | **200** |

No new error codes, no response-shape change, no new endpoint. Old clients
benefit without a release — an interceptor sees an ordinary successful refresh.

## 4. Ops

- Migration `20260803130000_add_refresh_token_lineage` is additive and nullable
  with no backfill — instant, no table rewrite, no downtime, safe to run ahead of
  the code deploy.
- Kill switch: `REFRESH_GRACE_SECONDS=0` disables grace entirely and restores the
  old behaviour, without a code change.
- Logs to watch (`mobile-api`):
  - `auth.refresh.grace_replay` — a logout that was prevented. Its rate is the
    direct measure of how much of the bug was real.
  - `auth.refresh.session_revoked` — a session genuinely ended. After this ships,
    this should correlate with real logouts / password changes; if it does not,
    something else is revoking sessions.

## 5. Not covered

- **Silent social re-auth still kicks the session.** `loginWithSocial` funnels
  into `issueTokenBundle`, which revokes every live mobile session. A Google/Apple
  re-auth on app resume therefore kicks the very session it is refreshing. The
  backend genuinely cannot tell that apart from a login on a second device —
  both are a social grant for the same member. The fix is either mobile-side (use
  the refresh grant on resume) or a `device_id` on `refresh_tokens` so
  single-session becomes per-device. The latter is a session-policy change, not a
  bug fix. Separate ticket.
- **RTR reuse-detection.** Replaying a superseded token *outside* the window is a
  theft signal; the lineage chain now makes family revocation possible. Not built
  — deliberately kept out of the same release as the branch rework.
- **Access TTL revert.** `JWT_ACCESS_EXPIRES_IN` is at the interim `7d`. Once
  grace is verified in production, return it to `15m` (or `24h`) via Secrets
  Manager + `--force-new-deployment`. That closes PRD §12's exit condition.
- **Deactivation lag.** `assertSessionActive` checks the session row, not
  `members.is_active`, so a resync-driven deactivation only bites when the access
  token expires. Pre-existing, unchanged by this work, and worse while the TTL is
  7d — mitigation is to revoke sessions in `apps/resync-worker/src/syncers/members.ts`.

## 6. Tests

`apps/mobile-api/tests/auth-refresh-grace.spec.ts` — replay idempotency, parallel
refresh converging on one successor, rotation tail, out-of-window termination,
forward walk, logout/kick not receiving grace, deactivated member refused,
lineage pointer recorded.

Two cases in `auth-single-session.spec.ts` asserted that rotation is *instantly*
terminal — they encoded the pre-fix contract. They now backdate `revoked_at` past
the window to assert the terminal state, which is the behaviour that actually
still holds.
