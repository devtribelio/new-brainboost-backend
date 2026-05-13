/**
 * Commerce module constants — sourced from legacy parity rules.
 * See docs/commerce-port.md §8 and CLAUDE.md §5.
 */

export const COMMERCE_PAYMENT_TYPES = ['cc', 'va', 'eWallet', 'voucher'] as const;
export type CommercePaymentTypeLiteral = (typeof COMMERCE_PAYMENT_TYPES)[number];

export const VA_BANKS = ['BCA', 'BNI', 'MANDIRI', 'BRI', 'PERMATA'] as const;
export type VaBank = (typeof VA_BANKS)[number];

export const EWALLET_TYPES = ['OVO', 'DANA', 'LINKAJA', 'GOPAY', 'SHOPEEPAY'] as const;
export type EwalletType = (typeof EWALLET_TYPES)[number];

export const ORDER_CODE_PREFIX = 'BB';

/**
 * Static gateway fee table per channel (IDR, flat).
 * Source: Xendit standard pricing — values may need product/finance review before launch.
 * Per-product/per-network fee override NOT supported in MVP.
 */
export const FEE_CC = 12_500;

export const FEE_VA: Record<VaBank, number> = {
  BCA: 4_000,
  BNI: 4_000,
  MANDIRI: 4_000,
  BRI: 5_500,
  PERMATA: 4_500,
};

export const FEE_EWALLET: Record<EwalletType, number> = {
  OVO: 9_900,
  DANA: 6_750,
  LINKAJA: 6_750,
  GOPAY: 9_000,
  SHOPEEPAY: 9_000,
};
