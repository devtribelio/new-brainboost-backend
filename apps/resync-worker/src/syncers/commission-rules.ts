/**
 * Rules for the commissions syncer (docs/legacy-resync-plan.md §6).
 *
 * BUYER  legacy affiliator_commision.member_downline_id is NOT the buyer: the commission
 *        writers (TBAffiliator_Commision_*::createCommision) store the recipient's tree
 *        node there — the L1 affiliator, or the recipient itself on a PERFORMANCE L1 row.
 *        The buyer is `member_id` on the payment row that `payment_model`/`payment_id`
 *        point at; every legacy commission writer sets one of the models below.
 */

/** legacy payment_model → payment table (PK = `<table>_id`, buyer = `member_id`). */
export const PAYMENT_TABLE_BY_MODEL: Readonly<Record<string, string>> = {
  TBModel_CoursePayment: 'course_payment',
  TBModel_ProductBundlePayment: 'product_bundle_payment',
  TBModel_ProductDigitalPayment: 'product_digital_payment',
  TBModel_ProductBookPayment: 'product_book_payment',
  TBModel_MemberNetworkPayment: 'member_network_payment',
  // TBModel_CanvasCheckoutPayment deliberately absent: canvas_checkout_payment has NO
  // member_id column (guest checkout), so a subquery on it would fail the whole scan —
  // its buyer resolves to NULL via the ELSE branch.
};

/**
 * SQL expression (aliased `buyer_member_id`) resolving the buyer's legacy member id from
 * the commission's payment row; NULL for an unknown model or a missing payment. Meant for
 * a `SELECT … FROM affiliator_commision` (unaliased).
 */
export function buyerLegacyIdSql(): string {
  const whens = Object.entries(PAYMENT_TABLE_BY_MODEL)
    .map(
      ([model, table]) =>
        `WHEN '${model}' THEN (SELECT p.member_id FROM ${table} p WHERE p.${table}_id = affiliator_commision.payment_id)`,
    )
    .join(' ');
  return `CASE affiliator_commision.payment_model ${whens} ELSE NULL END AS buyer_member_id`;
}

const AFFILIATE_BASED_VALUES = new Set(['PERFORMANCE', 'GROWTH', 'INACTIVE']);

/**
 * Recipient mode for a migrated commission (audit 08 F5). Legacy stores `affiliate_based` on
 * the commission, but older rows have it NULL (the column had no default). PERFORMANCE only
 * ever pays level 1, so a NULL row at level ≥2 is unambiguously GROWTH — defaulting those to
 * PERFORMANCE mislabels history and mis-resolves the rate on a re-scan. A NULL at level 1
 * stays PERFORMANCE: it cannot be told apart from INACTIVE without the payment's own
 * `affiliate_based`, and PERFORMANCE is the member default.
 */
export function resolveAffiliateBased(raw: unknown, level: number): string {
  const s = typeof raw === 'string' && AFFILIATE_BASED_VALUES.has(raw) ? raw : null;
  if (s) return s;
  return level > 1 ? 'GROWTH' : 'PERFORMANCE';
}

export interface CommissionUpdateInput {
  status: string;
  amount: number;
  commissionRate: number;
  recipientId: string;
  level: number;
  affiliateBased: string;
  buyerMemberId: string | null;
  productId: string | null;
}

/**
 * The UPDATE branch for an already-migrated legacy commission. Status/amount/rate follow
 * legacy as before; recipient/level/mode/buyer/product are refreshed too, so a forced re-scan
 * (or a redirect/split that moved the recipient) heals old rows. The buyer is always rewritten
 * (the stored value came from member_downline_id and is wrong whenever it differs); a product
 * is never nulled out — an unresolved product means "not migrated (yet)", not "this commission
 * has no product". Migrated rows carry `paymentId = null`, so changing the (payment, recipient,
 * level) unique key cannot collide with another migrated row.
 */
export function planCommissionUpdate(f: CommissionUpdateInput): Record<string, unknown> {
  return {
    status: f.status,
    amount: f.amount,
    commissionRate: f.commissionRate,
    recipientId: f.recipientId,
    level: f.level,
    affiliateBased: f.affiliateBased,
    buyerMemberId: f.buyerMemberId,
    ...(f.productId !== null ? { productId: f.productId } : {}),
  };
}
