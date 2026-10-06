import { describe, expect, it } from 'vitest';
import {
  buyerLegacyIdSql,
  PAYMENT_TABLE_BY_MODEL,
  planCommissionUpdate,
  resolveAffiliateBased,
} from '../src/syncers/commission-rules';

describe('buyerLegacyIdSql', () => {
  it('reads the buyer from the payment row, never from member_downline_id', () => {
    const sql = buyerLegacyIdSql();
    expect(sql).not.toContain('member_downline_id');
    expect(sql).toContain(
      "WHEN 'TBModel_CoursePayment' THEN (SELECT p.member_id FROM course_payment p WHERE p.course_payment_id = affiliator_commision.payment_id)",
    );
    expect(sql).toMatch(/ELSE NULL END AS buyer_member_id$/);
  });

  it('covers every legacy commission payment model', () => {
    const sql = buyerLegacyIdSql();
    for (const [model, table] of Object.entries(PAYMENT_TABLE_BY_MODEL)) {
      expect(sql).toContain(`WHEN '${model}' THEN (SELECT p.member_id FROM ${table} p WHERE p.${table}_id =`);
    }
    expect(Object.keys(PAYMENT_TABLE_BY_MODEL)).toHaveLength(5);
  });

  it('never subqueries canvas_checkout_payment (no member_id column) — its buyer is NULL', () => {
    const sql = buyerLegacyIdSql();
    expect(sql).not.toContain('canvas_checkout_payment');
    expect(sql).toContain('ELSE NULL END AS buyer_member_id');
  });
});

describe('resolveAffiliateBased', () => {
  it('keeps a known legacy mode', () => {
    expect(resolveAffiliateBased('GROWTH', 1)).toBe('GROWTH');
    expect(resolveAffiliateBased('INACTIVE', 3)).toBe('INACTIVE');
    expect(resolveAffiliateBased('PERFORMANCE', 1)).toBe('PERFORMANCE');
  });

  it('maps a NULL mode at level ≥2 to GROWTH (PERFORMANCE pays L1 only)', () => {
    expect(resolveAffiliateBased(null, 2)).toBe('GROWTH');
    expect(resolveAffiliateBased(undefined, 4)).toBe('GROWTH');
    expect(resolveAffiliateBased('', 3)).toBe('GROWTH');
  });

  it('keeps a NULL level-1 mode as PERFORMANCE', () => {
    expect(resolveAffiliateBased(null, 1)).toBe('PERFORMANCE');
  });
});

describe('planCommissionUpdate', () => {
  const base = {
    status: 'MIGRATED',
    amount: 100,
    commissionRate: 20,
    recipientId: 'recip',
    level: 2,
    affiliateBased: 'GROWTH',
    buyerMemberId: 'buyer',
    productId: 'prod',
  };

  it('refreshes recipient/level/mode/buyer/product alongside the money fields', () => {
    expect(planCommissionUpdate(base)).toEqual(base);
  });

  it('clears a wrong buyer when the payment buyer is unresolvable', () => {
    expect(planCommissionUpdate({ ...base, buyerMemberId: null })).toMatchObject({ buyerMemberId: null });
  });

  it('never nulls out a stored product', () => {
    expect(planCommissionUpdate({ ...base, productId: null })).not.toHaveProperty('productId');
  });

  it('re-points recipient and level so a redirect/split heals old rows', () => {
    expect(planCommissionUpdate({ ...base, recipientId: 'other', level: 3 })).toMatchObject({
      recipientId: 'other',
      level: 3,
    });
  });

  it('touches only the expected keys (payment/createdAt stay as created)', () => {
    expect(Object.keys(planCommissionUpdate(base)).sort()).toEqual(
      ['affiliateBased', 'amount', 'buyerMemberId', 'commissionRate', 'level', 'productId', 'recipientId', 'status'],
    );
  });
});
