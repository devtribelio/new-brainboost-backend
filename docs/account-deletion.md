# Account deletion

Member-initiated account deletion: a 30-day grace period, then an anonymisation that
destroys the identity while keeping the row and every financial record attached to it.
The PII is gone for good; the balance and history can still be reclaimed through support
(§6), which is re-onboarding onto the same row rather than an undelete.

Spec owner: `apps/mobile-api/src/modules/account/` + `packages/domain/src/jobs/purge-scheduled-deletions.ts`.

---

## 1. States

| State | `scheduled_deletion_at` | `deleted_at` | `is_active` |
|---|---|---|---|
| Normal | NULL | NULL | true |
| Scheduled (recoverable) | future date | NULL | false until the owner logs back in, then true |
| Executed (final) | past date | set | false |

`scheduled_deletion_at` is the **deadline**. `deleted_at` is the **receipt**. They are
separate because recovery is gated on the deadline, never on whether the hourly purge
happens to have run yet — otherwise whether an account can be saved would depend on
cron timing, which is untestable and impossible to explain to a user.

Grace period defaults to **30 days** (`SCHEDULED_DELETION_DAYS`, `account.service.ts`) and
is runtime-overridable through `app_settings` → `account.deletionGraceDays`
(`SETTING_KEYS.accountDeletionGraceDays`, seeded 30).

Changing it is safe at any time. `verificationDeleteAccount` computes the deadline ONCE
and stores it as an absolute date, so a new value only affects deletions scheduled after
it — accounts already in flight keep the date their owner was promised, and nothing is
pulled forward behind their back. Storing the request date and deriving the deadline on
read would not have that property: lowering the number would retroactively expire a whole
cohort at once.

Ops caveat: if the app ships static copy naming the number of days, that copy has to move
with the setting, or the screen starts lying. FE reads the actual date from
`scheduledDeletionAt` (§2), so the banner itself is always correct.

## 2. Flow

```
POST /api/member/account/requestDeleteAccount      { agree: true }   → OTP
POST /api/member/account/verificationDeleteAccount { otpCode }       → schedules
POST /api/member/account/recoverAccountScheduled                     → cancels
```

`verificationDeleteAccount` sets the deadline, deactivates the row, and revokes every
live refresh token.

### Recovery is two steps on purpose

Logging in during the window **reopens the account but does not cancel the deletion**.
The deadline survives; FE reads it from `scheduledDeletionAt` on the profile payload
and renders a banner; cancelling is an explicit tap on `recoverAccountScheduled`.

Auto-cancelling on login was rejected. An app opened out of habit, a password manager
autofill, or the one-tap "Continue with Google" would call off a deletion the member
deliberately asked for — and they would never find out, because nothing would be shown
and no message would be sent. A deletion that silently does not happen is the exact
failure this feature exists to prevent. Doing nothing after the banner still deletes.

### Why the login gate had to change at all

Before this work `recoverAccountScheduled` was **unreachable**. It requires `authGuard`,
but `verificationDeleteAccount` revokes every refresh token and sets `is_active = false`,
after which every door is shut: `assertSessionActive` answers `SESSION_REVOKED` (the
rows were revoked without a successor, so the rotation grace does not apply), password
login returns `INVALID_CREDENTIALS`, and both social paths plus refresh return
`MEMBER_INACTIVE`. The grace period existed on paper only.

`reopenWithinDeletionGrace` (`auth.service.ts`) now relaxes exactly three call sites —
`loginWithPassword`, the `loginWithSocial` provider-sub fast path, and
`linkSocialToExistingMember` — under one narrow condition:

```
!isActive && deletedAt == null && scheduledDeletionAt != null && scheduledDeletionAt > now()
```

Everything outside that condition rejects exactly as before, so banned and
legacy-deactivated members are unaffected. `loginWithRefreshToken` is deliberately NOT
relaxed: the tokens are already revoked, and forcing a fresh login is what makes the
return a deliberate act.

`is_active` was NOT widened to mean "active or pending deletion". That would silently
change the meaning of every `is_active` check in the codebase, including the ones in
checkout and disbursement.

## 3. What the purge does

`purgeScheduledDeletions` (hourly, `bb-cron` lane) claims each due row conditionally
before touching it:

```sql
UPDATE members SET deleted_at = now()
WHERE id = $1 AND deleted_at IS NULL
  AND scheduled_deletion_at IS NOT NULL AND scheduled_deletion_at <= now()
```

Zero rows matched = the member logged in and cancelled between the scan and here, so
the row is left alone. The claim and the rewrite share one transaction. Same
conditional-update pattern as refresh-token rotation and voucher redeem.

### Why soft, not hard

A real `DELETE` is not available:

- Four FKs are `ON DELETE RESTRICT` — `commerce_transactions`, `commerce_payments`,
  `event_tickets.buyer_member_id`, `affiliate_visits.affiliator_member_id`. Any member
  who ever transacted or was ever promoted cannot be deleted at all.
- The `CASCADE` FKs would take `affiliate_commissions`, `affiliate_disbursements` (the
  payout record reconciled against Xendit) and `kyc_event` (the AML trail) with them.
- `members.inviter_id` is `ON DELETE SET NULL`, so deleting a mid-chain member severs
  `walkInviterChain` and permanently stops every upline above them from earning on that
  downline — silently, with no error.

Keeping the row and destroying the PII on it satisfies both sides.

### Column rules

**Unique columns → rewritten** (`packages/common/src/utils/anonymize.util.ts`):

| Column | Result |
|---|---|
| `email` | `del:<member uuid>:b***@gmail.com` |
| `phone` | `del:<member uuid>:0812****789` |
| `username` | `del:<member uuid>:bu***` |

The member's own UUID makes every value distinct by construction. A fixed prefix would
collide on the second deletion of the same address (P2002), and `jobs-runner` swallows
per-job errors, so that row would never be purged and nobody would be told.

The shape is deliberately **not a valid email address** — the colons sit in the local
part — so an outbound path that ever fails to filter deleted members fails validation
instead of mailing a live domain.

Rewriting rather than NULLing is what keeps the row legible in backoffice. The address
itself is not recoverable from the mask.

**Unique but opaque → NULL**: `google_sub`, `apple_sub`, `kyc_provider_ref`.
`google_sub` matters most: leave it set and the person is free to re-register by email
yet gets an unexplained `409 CONFLICT` the moment they tap "Continue with Google".

**Non-unique PII → NULL**: `phone_code`, `full_name`, `avatar_url`, `cover_url`, `bio`,
`birthdate`, `gender`, `latitude`, `longitude`, `bank_code`, `bank_account_number`,
`bank_account_name`, `kyc_id_number`, `kyc_id_type`, `kyc_id_card_url`,
`kyc_selfie_url`; plus `member_profiles.address` / `postal_code`.

`full_name` is NULL rather than masked because it is rendered to **other** members —
`affiliator.service.ts` shows the buyer's name in an affiliator's commission history.

`password_hash` gets a random value and `password_algo` becomes `deleted`, which
`verifyPassword` refuses before the hash is compared (same early return as `social`).

**Outside `members`:**

- `commerce_transactions.buyer_email` / `buyer_phone` → masked. **Required, not
  cosmetic.** `mayReadOrder` (`event.service.ts`) accepts `buyer_email` as a credential
  for `GET /api/event/order/:code`, and order codes are enumerable (a per-day counter).
  Leaving it while freeing the address for re-registration would let whoever next
  registers that email open the previous owner's order page, which lists every
  attendee's name and email.
- `event_tickets.attendee_name` / `attendee_email` / `attendee_phone` → masked, but
  **only for this member's own tickets** (`member_id` = them, or bought by them and
  addressed to their own mailbox). A ticket they bought for somebody else carries a
  third party's details; that person did not ask to be deleted.

**Kept:** `legacy_id`, `code`, `affiliate_code`, `affiliate_based`, `inviter_id`,
`created_at`, and every financial row. `affiliate_code` in particular is not freed —
reassigning it would make `?ref=ABC123` on already-printed material credit a different
member.

## 4. Re-registration

The freed email/phone/username can be registered again immediately. That creates a
**new account with a new UUID** — purchases, enrollments, progress and commission
balance stay on the old anonymised row and are not reachable.

Support will be asked *"I registered again with the same email, where are my courses?"*
The answer is that this is what deletion means.

## 5. Affiliate: deleted members earn nothing

`commitCommissionsForPayment` skips a chain node whose `deleted_at` is set. The node
**stays in the chain** and every other level keeps its position.

The tempting alternative — NULL the downline's `inviter_id` at purge time — is wrong.
The function seeds from `buyer.inviterId` and returns early when it is absent, so
clearing it stops the walk before it starts and everyone above loses their commission
too. On a 1 000 000 purchase through D → C → B → A with C deleted:

| | C (deleted) | B | A |
|---|---|---|---|
| Normal | 200 000 | 100 000 | 50 000 |
| NULL `inviter_id` | 0 | **0** | **0** |
| Skip the row (implemented) | 0 | 100 000 | 50 000 |

Dropping the node from the chain instead would promote B from L2 (10%) to L1 (20%) —
a raise triggered by a third party closing their account. Regression test:
`apps/mobile-api/tests/affiliate/deleted-recipient-no-commission.spec.ts`.

### Commission stays on the books; the pending payout does not

Commission rows are **not** touched at purge — not voided, not restated. The commission
was genuinely earned at sale time, so the expense stays booked and finance reports keep
reading the numbers they read yesterday. Voiding would be a write-off in a later period
than the one it undoes, and it would have to be reversed again the moment support reopens
the account. Nothing needs it either: the balance is already unreachable, because the
account cannot log in.

Consequence to accept: `affiliatePendingToBalance` does not filter deleted rows, so
`PENDING` commission keeps clearing to `BALANCE` on schedule. Under this design that is
correct — the hold elapsed, the money is owed, it is simply unclaimed — but "commission
owed" totals carry balances for accounts that mostly never come back.

**A payout still `PENDING` is different and does die at purge.** Safety stop, not
bookkeeping: `affiliate_disbursements` snapshots `bank_code` / `bank_account_number` /
`bank_account_name` at request time, so clearing `members.bank_*` does nothing to stop
one, and `executeApprovedDisbursements` gates only on `kycStatus`. Wiring money to a
snapshotted account whose owner can no longer be verified is the one outcome here that
cannot be undone. `VOIDED` also releases the held balance, so a restored account finds
its money available again — the request was cancelled, the money was not.
`execute-approved-disbursements.ts` additionally filters `member: { deletedAt: null }` as
a standalone net. `PROCESSING` is deliberately untouched: the money is already at Xendit,
voiding our row would not recall it, and the callback still needs a row it recognises.

### KYC is revoked, because its evidence is destroyed

The purge sets `kycStatus: 'EXPIRED'` (plus a `kyc_event` `RESET` / `ACCOUNT_DELETED`
row, written in the same transaction) whenever the member was `APPROVED`.

This is load-bearing, not hygiene. The payout gate is one line —
`if (member.kycStatus !== 'APPROVED') throw` (`disbursement.service.ts:209`) — while the
purge destroys `kyc_id_number`, `kyc_id_type` and both document images. Left `APPROVED`,
an account reopened over the counter would walk straight through that gate with **zero
KYC on file**. `EXPIRED` already means "was approved, must re-verify" and the gate answers
`KYC_EXPIRED` for it, so re-verification before any withdrawal is automatic.

`isEmailVerified` and `isPhoneVerified` are set false for the same reason: both describe
an address and a number that no longer exist on the row, and a restored account given a
new email must not inherit a verified stamp for a mailbox nobody has proven.

Only `APPROVED` is downgraded. `NONE` / `REJECTED` have nothing to revoke, and `PENDING`
is already blocked by the gate — the same no-op rule as `DisbursementService.resetKyc`.

## 6. Recovery after the purge

Self-service recovery ends at the deadline. Past it, support reopens the row.

**It is re-onboarding, not an undelete.** What survives is the money and the
relationships; the identity does not:

| Data | After purge | Support can restore? |
|---|---|---|
| Commission, balance | Intact | Yes — no action needed |
| Enrollments, course progress | Intact | Yes |
| Affiliate tree, `inviter_id` | Intact | Yes |
| `affiliate_code`, `code`, order history | Intact | Yes |
| Email, phone | Masked | No — must be re-entered |
| Password | Random | No — must be reset |
| Google / Apple login | NULL | No — must be re-linked |
| Name, bio, avatar | NULL | No |
| Bank account | NULL | No — must be re-entered |
| KYC (ID number, images) | NULL | **No — must re-verify** |

The product story that follows is coherent and worth saying plainly to the member: *your
personal data is permanently deleted; your balance and purchase history can be reclaimed.*

**Known-open — identity verification.** Everything normally used to prove account
ownership (email, phone, ID number, document images) is exactly what the purge destroys.
What is left to check a caller against — `affiliate_code`, `code`, `legacy_id`, order
codes, amounts and dates, the enrollment list — is all knowable by other people, and the
affiliate code is deliberately published in promo links. Mandatory re-KYC before
withdrawal is the mitigation in place: it proves the claimant is a real identifiable
person before any money moves, and it is enforced automatically by the `EXPIRED` status
above. It does **not** prove they are the same person who owned the account — closing that
would need an identity anchor kept across the purge, such as a hash of the KYC ID number,
which was considered and not built. Treat a high-balance recovery as a manual risk
decision, not a routine ticket.

**Known-open — duplicate accounts.** Because masking frees the address, a member who
re-registers before asking for recovery ends up with two rows: a new one holding new
purchases, an old one holding the commission balance. Merging them is separate work and
is not covered here.

## 7. Backoffice

Implementation lives in the `backoffice-bb` repo (raw SQL, no Prisma), same split as
disbursement approval: the state machine and every rule stay here, backoffice writes the
columns.

There are **two different operations**, and conflating them into one button is the main
thing to avoid — they have different preconditions, different risk, and different
follow-up for the member.

### 7.1 Cancel a scheduled deletion (before the deadline)

For someone who asked to delete, changed their mind, and cannot do it themselves —
typically because they lost access to the mailbox they log in with. Identical in effect to
the member's own `recoverAccountScheduled`.

```sql
UPDATE members
   SET scheduled_deletion_at = NULL, is_active = true, updated_at = now()
 WHERE id = $1
   AND deleted_at IS NULL
   AND scheduled_deletion_at IS NOT NULL
   AND scheduled_deletion_at > now();
```

Zero rows updated = past the deadline or already purged. Surface that as a refusal and
route the agent to 7.2 — never report it as success.

Nothing else is needed: no PII was touched yet, so the account works again immediately
with its original credentials.

### 7.2 Restore a purged account (after the deadline)

**This is re-onboarding, not an undelete.** The money and the relationships are intact;
the identity is gone and cannot be brought back (§6). Say this to the member in those
terms — they will expect their old login to work, and it will not.

**Finding the row.** The email is masked, which is exactly what makes it searchable: the
domain and first character survive. Offer lookup by

- masked email — `email LIKE 'del:%:b%@gmail.com'`, or just `email LIKE '%@gmail.com'`
- `affiliate_code`, `code`, `legacy_id`
- order code → `commerce_transactions.code` → `member_id`
- member UUID, when the member has it from an old receipt

**Verification screen.** Everything that normally proves ownership was destroyed by the
purge, so the agent has to work from what is left. Show, for the agent to question the
caller on:

| Field | Used for |
|---|---|
| Masked email / phone | "Is your email at gmail? Does your number end in 789?" |
| Order codes, dates, amounts, product names | Only a real buyer knows what they bought and roughly when |
| Enrollment list | Same |
| Commission balance, registration date | Corroboration |
| `affiliate_code`, `code`, `legacy_id`, deletion date | Reference |

None of this is strong evidence — see the known-open note in §6. Treat a high balance as a
manual risk decision.

**The write.** One statement, guarded:

```sql
UPDATE members
   SET email = $2,              -- the new address the caller controls
       deleted_at = NULL,
       scheduled_deletion_at = NULL,
       is_active = true,
       updated_at = now()
 WHERE id = $1
   AND deleted_at IS NOT NULL;
```

Guard on `deleted_at IS NOT NULL` so this can never be fired at a live account. A unique
violation on `email` means that address now belongs to somebody else (possibly the caller's
own re-registration) — surface it plainly and ask for a different one.

**Deliberately NOT set by this statement:**

- `is_email_verified` stays **false**. The forgot-password OTP below proves mailbox
  control, but only `validateOtpEmail` earns the verified flag — and leaving it false
  keeps the email editable, so a typo by the agent is fixable rather than locked in
  (`EMAIL_LOCKED_AFTER_VERIFICATION`).
- `kyc_status` stays **EXPIRED**. This is what forces re-verification before any payout,
  automatically, with no extra check in backoffice.
- `password_hash` / `password_algo` stay as the purge left them. The member sets a new
  password themselves.
- `phone`, bank details, name, avatar: left masked/null. The member re-enters them.

**What the member does next.** Hand them this, in order:

1. Forgot password → **email only**. The phone path requires `is_phone_verified`, which
   the purge cleared, so it will silently answer "not registered".
2. Log in with the new password.
3. Re-enter bank details, then re-do KYC. Both are required before a payout; the KYC gate
   refuses with `KYC_EXPIRED` until Didit approves again.

Choosing the email IS the trust decision: whoever controls that mailbox can reset the
password and owns the account from then on. The OTP that follows proves mailbox control,
not that the right person named it.

### 7.3 Permissions and audit

Split the permission — viewing a deleted account is not the same right as reopening one
(suggested: `members.view_deleted` and `members.restore`). Reopening grants access to a
commission balance, so it belongs with the payout-approval tier, not with general member
support.

**Audit is the open piece.** `backoffice-bb` should log the action against its own
`bo_users` as it does for disbursement approval. But note that clearing `deleted_at`
erases the only evidence in *this* database that the account was ever purged — after a
restore, the row looks like it was merely scheduled and cancelled. If that history matters
(it does for a money-adjacent action), add two columns here:

```sql
ALTER TABLE "members" ADD COLUMN "restored_at" TIMESTAMP(3);
ALTER TABLE "members" ADD COLUMN "restored_by" UUID;   -- bo_users, no FK (same rule as approved_by)
```

Not built yet — it is a schema decision, not something backoffice can add on its side.

## 8. Known gaps

- **The member is never told what happens to their balance.** `requestDeleteAccount`
  checks the `agree` flag and nothing else — it does not read the balance and returns no
  figure. The money is no longer forfeited (commission rows survive, §3), but it does
  become unreachable without a support ticket, and the member is told none of that. It
  matters most for those who cannot withdraw first: the payout minimum is 15 000 and KYC
  must be `APPROVED`, so a member below either threshold has no way to cash out before
  deleting. Cheapest fix is returning the running balance from `requestDeleteAccount` so
  FE can show it on the confirmation screen.
- **No notification** at any point — no email when the deletion is scheduled, no
  reminder before the deadline, no confirmation once executed. A member who did not
  initiate it learns nothing.
- **No audit row.** Who deleted, when, and from which path is not recorded beyond
  `deleted_at` itself; a backoffice-triggered cancel is indistinguishable from the
  member's own.
- **`otp_codes` is not pruned** (pre-existing), so rows targeting the freed address
  outlive the account. Harmless — `resolveAndMatch` reads the newest row only.
- **Legacy resync** is filtered on `deleted_at IS NULL` (`apps/resync-worker/src/syncers/members.ts`).
  The touch-gate already covered this indirectly; the explicit filter guards against
  anything that re-levels `legacy_synced_at` and would otherwise let legacy write
  `full_name` / `avatar_url` back over the anonymised values.
