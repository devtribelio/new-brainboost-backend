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
