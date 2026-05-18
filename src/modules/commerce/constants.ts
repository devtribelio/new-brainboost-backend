/**
 * Commerce module constants.
 *
 * Payment via Xendit Invoice API (hosted checkout). Channels (VA/eWallet/CC)
 * are picked by user in the hosted page — backend does not pre-route. Fee is
 * absorbed by Xendit pricing display.
 */

export const COMMERCE_PAYMENT_TYPES = ['invoice', 'voucher'] as const;
export type CommercePaymentTypeLiteral = (typeof COMMERCE_PAYMENT_TYPES)[number];

export const ORDER_CODE_PREFIX = 'BB';
