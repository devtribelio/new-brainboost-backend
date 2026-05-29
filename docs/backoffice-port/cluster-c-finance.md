# Backoffice Port — Cluster C: Finance / Voucher / Disbursement

Legacy scope: `tribelio-admin/default/controllers/` — `bank.php`, `balancemanual/**`, `disbursement/**`, `finance/**`, `datafinance/**`, `transaction/**`, `purchase/**`, `voucher/**`, `marketing/**`, `reloadBa.php`.

**Totals:** 34 endpoints — **P0: 5 · P1: 14 · P2: 2 · SKIP: 13**

---

## Inventory

| Legacy URL | Controller:action | Purpose | Lib | New entity | Mobile-admin? | Priority | Notes |
|---|---|---|---|---|---|---|---|
| /bank/index | bank:index | List bank accounts (payout routing) | TBBank | BankAccount (new) | YES | P1 | `GET /api/backoffice/banks`. |
| /bank/add /edit/{id} | bank:add/edit | Bank CRUD | TBBank | BankAccount | YES | P1 | `POST /api/backoffice/banks`, `PUT /:id`. |
| /bank/delete/{id} | bank:delete | Soft-delete bank | TBBank | BankAccount | YES | P1 | `DELETE /api/backoffice/banks/{id}`. |
| /balancemanual/account/index | balancemanual/account:index | Manual member balance adjust list | TBBalance, TBManualBalance | BalanceAdjustment (new) | YES | **P0** | `GET /api/backoffice/balance-adjustments?memberId=`. |
| /balancemanual/account/add | balancemanual/account:add | Create balance adjust (amount + memo) | TBManualBalance | BalanceAdjustment | YES | **P0** | `POST /api/backoffice/members/{id}/balance-adjust { amount, memo }`. Audit log required. Atomic SQL + journal row. |
| /balancemanual/addon/index | balancemanual/addon:index | Manual course-bundle grants | TBBalance, TBAffiliateAddon | CourseEnrollment | YES | P1 | `GET /api/backoffice/members/{id}/manual-enrollments`. |
| /balancemanual/addon/add | balancemanual/addon:add | Grant course access manually | TBAffiliateAddon | CourseEnrollment | YES | P1 | `POST /api/backoffice/members/{id}/grant-enrollment { productId, reason }`. |
| /disbursement/affiliate/index | disbursement/affiliate:index | Withdrawal requests (pending/approved/rejected) | TBDisbursement_Affiliate, TBWithdraw | AffiliateDisbursement extension | YES | P1 | `GET /api/backoffice/disbursements/affiliate?status=`. |
| /disbursement/commerce/index | disbursement/commerce:index | Commerce refund/payout requests | TBDisbursement_Commerce, TBRefund | CommerceRefund (new) | YES | P1 | `GET /api/backoffice/disbursements/commerce?status=`. |
| /finance/balance/index | finance/balance:index | Member balance ledger | TBBalance, TBCommerce | derived | YES | P2 | `GET /api/backoffice/finance/balance?from=&to=` (export CSV). |
| /finance/refund/index | finance/refund:index | Refund list | TBRefund | CommerceRefund | YES | **P0** | `GET /api/backoffice/finance/refunds?status=`. |
| /finance/refund/datacallback | finance/refund:datacallback | Reload refunds w/ filters | TBRefund | CommerceRefund | YES | P1 | Same endpoint, filter params. |
| /finance/refund/uploadRefundProof | finance/refund:uploadRefundProof | Upload refund proof | TBRefund | CommerceRefund | YES | P1 | `POST /api/backoffice/finance/refunds/{id}/proof` (multipart). |
| /finance/withdraw/index | finance/withdraw:index | Withdrawal list w/ approval | TBWithdraw | AffiliateDisbursement | YES | **P0** | `GET /api/backoffice/finance/withdrawals?status=`. Same data as /disbursement/affiliate; expose under both routes? — pick one, prefer `/disbursements/affiliate`. |
| /finance/withdraw/approved | finance/withdraw:approved | Approve withdraw + trigger payout | TBDisbursement_Withdraw::execute | AffiliateDisbursement | YES | **P0** | `PUT /api/backoffice/disbursements/affiliate/{id}/approve`. Triggers PayoutJob. |
| /finance/withdraw/rejected | finance/withdraw:rejected | Reject withdraw w/ memo | TBWithdraw | AffiliateDisbursement | YES | **P0** | `PUT /api/backoffice/disbursements/affiliate/{id}/reject { reason }`. |
| /transaction/payment/index | transaction/payment:index | (constructor only, no action) | — | — | NO | SKIP | Inactive in legacy. |
| /purchase/challenge/index | purchase/challenge:index | Course challenges | — | — | NO | SKIP | Optional feature, not in MVP. |
| /voucher/manual/index | voucher/manual:index | Manual voucher list | TBVoucher | Voucher | YES | P1 | `GET /api/backoffice/vouchers?type=MANUAL`. Existing EJS admin lacks voucher resource — backoffice adds full mgmt. |
| /voucher/manual/add | voucher/manual:add | Create voucher | TBVoucher | Voucher | YES | P1 | `POST /api/backoffice/vouchers`. |
| /voucher/manual/edit/{id} | voucher/manual:edit | Edit voucher | TBVoucher | Voucher | YES | P1 | `PUT /api/backoffice/vouchers/{id}`. |
| /voucher/manual/delete/{id} | voucher/manual:delete | Deactivate voucher | TBVoucher | Voucher | YES | P1 | `DELETE /api/backoffice/vouchers/{id}`. |
| /voucher/manual/exportExcelVoucher | voucher/manual:exportExcelVoucher | Export voucher codes Excel | TBVoucher | Voucher | YES | P2 | `GET /api/backoffice/vouchers/export?type=MANUAL`. |
| /voucher/manual/modalAddBlackList | voucher/manual:modalAddBlackList | Voucher blacklist member | TBVoucher | VoucherBlacklist (new) | YES | P2 | `POST /api/backoffice/vouchers/{id}/blacklist { memberId }`. |
| /voucher/automated/index /add | voucher/automated:* | Auto-issued vouchers (rules) | TBVoucher | — | NO | SKIP | Loyalty automation, defer. |
| /marketing/instantPayment/index /hold | marketing/instantPayment:* | Instant-pay promos | — | — | NO | SKIP | Campaign ops, not transactional. |
| /marketing/package/index /add /edit /delete | marketing/package:* | Product bundles | TBPlan | — | NO | SKIP | Multi-product bundles not in MVP. |
| /reloadBa/reloadBaSelect | reloadBa:reloadBaSelect | BA dropdown helper | — | — | NO | SKIP | FE concern. |
| /datafinance/data /transaction | datafinance:* | Legacy folder stubs | — | — | NO | SKIP | Verify inactive — confirmed empty/folder-only. |

---

## Cluster summary

- **Total:** 34 endpoints.
- **P0 (5):** balance-adjust (list + create), refund list, withdraw approve + reject.
- **P1 (14):** bank CRUD, disbursement lists (affiliate + commerce), addon grant, refund detail + proof upload, voucher CRUD.
- **P2 (2):** balance ledger export, voucher blacklist.
- **Drops:** automated vouchers, marketing/instantPayment, multi-product bundles (`marketing/package`), legacy folder stubs.
- **Top integration risks vs commerce module:**
  1. **Refund flow collision.** Legacy `TBRefund` marks payments PAID manually, bypassing Xendit webhook. New flow must use explicit reversal job → reverse `CourseEnrollment` → emit `DisbursementCreated`. Do NOT replicate the legacy hack.
  2. **Manual balance adjust vs commission ledger race.** `affiliate.disbursement.service` computes balance dynamically. Manual adjust = atomic SQL UPDATE + journal row in `BalanceAdjustment`, not async sync.
  3. **Bank routing not modeled.** `affiliate.disbursement.service` lacks bank selection. Add `BankAccount` + `Member.bankAccountId` link; migrate legacy `TBDisbursement.bank_id`.

## New Prisma tables for this cluster

- `BankAccount` (sprint 2): `{ id, name, code (e.g. BCA), swift, isActive, position }`
- `MemberBankAccount` (sprint 2, optional): `{ id, memberId, bankAccountId, accountNumber, holderName, verifiedAt }`
- `AffiliateDisbursement` extension (sprint 2): `{ status (PENDING/APPROVED/REJECTED/PAID), approvedById, approvedAt, paidAt, rejectionReason, manualAdjustNote, bankAccountId }`
- `CommerceRefund` (sprint 3): `{ id, transactionId, amount, reason, status (REQUESTED/APPROVED/REJECTED/PAID), requestedById, approvedById, approvedAt, paidAt, proofUrl }`
- `BalanceAdjustment` (sprint 3): `{ id, memberId, amount (signed), reason, type (CREDIT/DEBIT), createdById, createdAt }` + audit-log row
- `VoucherBlacklist` (sprint 6): `{ voucherId, memberId, blockedById, blockedAt }`
