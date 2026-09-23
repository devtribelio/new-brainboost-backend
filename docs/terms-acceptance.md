# Terms & conditions acceptance

Member-facing consent to the Terms & Conditions (one document, privacy policy included).
The app shows the document before first use and again whenever ops publish a new version;
the backend records who accepted which version when, and tells the app whether the
screen is due.

Spec owner: `apps/mobile-api/src/modules/account/` (`acceptTerms`, `terms-status.ts`).
FE contract: §5.

---

## 1. Decisions

| Question | Decision | Why |
|---|---|---|
| What is consent keyed to? | The **document version** (`app_settings` `terms.currentVersion`), never the app version | An app release with an unchanged document must not re-prompt anyone; a changed document must re-prompt everyone, on every build. `app_version` is still stored on the acceptance row for audit. |
| Where does the text live? | A **URL** (`terms.url`), rendered in a webview | No content table, no editor. The page is managed on the web. |
| Privacy policy? | Same document, same version | One prompt, one row. |
| Where does the app read the status? | The `terms` block on `GET /api/member/account/profile/info` | Already called on login and app resume. No new round trip on cold start. |
| Enforcement | **Client gate only.** No middleware answers 403 for a member who has not accepted | A global 403 would lock out every build that predates the T&C screen with no way to clear it. A hard gate is only safe once `force_below` in `app_version_configs` has retired those builds — phase 2, not built. |
| Ties to registration? | None. `RegisterDto` is unchanged | The app calls `acceptTerms` after first login — one path for new and existing members. |

## 2. Data

`member_terms_acceptances` (migration `20260923120000_member_terms_acceptance`) is the
proof of consent. Append-only, one row per `(member_id, terms_version)` (unique). It
carries `app_version` + `platform` from the `x-platform` header (audit only) and
`accepted_at`. **No IP column**: behind Cloudflare `req.ip` is the edge address, not the
visitor (`packages/common/src/utils/client-ip.util.ts`), so it would be noise and PII at
once. Without it the table holds no personal data and the account purge
(`purgeScheduledDeletions`) never has to touch it. FK is `ON DELETE CASCADE` like
`kyc_event` — the system never deletes a member row (purge = anonymise), so the cascade
only matters for test cleanup.

`members.terms_version` + `members.terms_accepted_at` cache the latest row for the read
path, the same split as `members.kyc*` vs `kyc_event`. NULL = never accepted.

`terms_version` is a **free-form label** compared with `!==`. It is not semver and is not
ordered; `2026-10-01` is the seeded value.

## 3. Settings (`app_settings`, seeded by `pnpm seed:settings`)

| Key | Seed | Meaning |
|---|---|---|
| `terms.enabled` | `false` | Kill-switch. `false` → `needsAcceptance` is always `false`. **Turn on only after the app build with the T&C screen has shipped**; earlier, every member is flagged with nothing able to clear it. |
| `terms.currentVersion` | `2026-10-01` | The live document version. **Bump only when the document changes**; every bump re-prompts every member within ~30 s (settings cache). |
| `terms.url` | `https://brainboost.id/terms` | Page the app renders before the accept button. |

Ops edit these from the backoffice over plain SQL; no redeploy for any of them.

## 4. Behaviour

`buildTermsStatus(member)` (`terms-status.ts`) is the **only** builder of the `terms`
block. The profile payload and the `acceptTerms` response both call it, so a client can
never read two different answers.

```
needsAcceptance = terms.enabled && member.termsVersion !== terms.currentVersion
```

`POST /api/member/account/acceptTerms` `{ version }` (`authGuard`):

1. `version !== terms.currentVersion` → `400 TERMS_VERSION_STALE`, `details.currentVersion`
   carries the live value. This check runs even while `terms.enabled=false`: a client that
   calls anyway must still learn that the document it showed is stale.
2. One transaction: insert the acceptance row; on the `(member, version)` unique
   (`P2002`) the call is a repeat and the original row and timestamp are kept; otherwise
   the member cache columns are updated. Idempotent.
3. Returns the `terms` block, already `needsAcceptance: false`, so the app need not refetch
   the profile.

The `x-platform` header (`ios`, or `android/3.3.1+412`) is parsed by the same validator
the tracker uses (`packages/common/src/utils/platform-header.util.ts`, moved there from
`tracking.controller.ts`); anything else is stored as NULL, never as the raw string.

## 5. FE contract

`GET /api/member/account/profile/info` — additive field (also present on the
`profile/update` and `profile/location` responses, which share the serializer):

```json
"terms": {
  "enabled": true,
  "currentVersion": "2026-10-01",
  "url": "https://brainboost.id/terms",
  "acceptedVersion": null,
  "acceptedAt": null,
  "needsAcceptance": true
}
```

Client rule: `needsAcceptance === true` → render `url` in a webview with an accept
button, then `POST /api/member/account/acceptTerms` with `{ "version": currentVersion }`
(send the version you displayed, never a hardcoded one) and the usual `x-platform` header.
On `400 TERMS_VERSION_STALE`, reload the profile and show the new `url`/`currentVersion`.
The response body is the same `terms` block, so update local state from it directly.

Nothing else in the app is blocked by the backend. Clients that predate the field keep
working; `terms.enabled=false` keeps the field present but never `true`.

## 6. Known gaps

- No hard gate (see §1). A member who dismisses the screen by killing the app is not
  stopped by the API.
- No backoffice page yet: `terms.*` are edited as raw `app_settings` rows. The acceptance
  log is readable over SQL (`member_terms_acceptances`).
- No per-member "withdraw consent" — deleting the account is the only route.
- `affiliate.controller.ts` still reads `x-platform` inline without validation; out of
  scope here.
