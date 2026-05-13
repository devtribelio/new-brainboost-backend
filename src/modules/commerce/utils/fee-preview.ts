import { FEE_CC, FEE_EWALLET, FEE_VA, type EwalletType, type VaBank } from '../constants';

export interface FeePreview {
  cc: number;
  va: Record<VaBank, number>;
  eWallet: Record<EwalletType, number>;
}

/**
 * Static fee preview — caller may show all channels in mobile picker.
 * Voucher 100% (amount=0) returns zero across the board.
 */
export function buildFeePreview(amount: number): FeePreview {
  if (amount === 0) {
    return {
      cc: 0,
      va: { BCA: 0, BNI: 0, MANDIRI: 0, BRI: 0, PERMATA: 0 },
      eWallet: { OVO: 0, DANA: 0, LINKAJA: 0, GOPAY: 0, SHOPEEPAY: 0 },
    };
  }
  return {
    cc: FEE_CC,
    va: { ...FEE_VA },
    eWallet: { ...FEE_EWALLET },
  };
}

/**
 * Resolve the fee for a chosen channel.
 * Throws for unknown bank/ewalletType so the caller surfaces a 400.
 */
export function resolveFee(
  paymentType: 'cc' | 'va' | 'eWallet' | 'voucher',
  channel: { bank?: string; ewalletType?: string },
): number {
  if (paymentType === 'voucher') return 0;
  if (paymentType === 'cc') return FEE_CC;
  if (paymentType === 'va') {
    const bank = channel.bank as VaBank | undefined;
    if (!bank || !(bank in FEE_VA)) {
      throw new Error(`Unsupported VA bank: ${channel.bank ?? '(none)'}`);
    }
    return FEE_VA[bank];
  }
  if (paymentType === 'eWallet') {
    const t = channel.ewalletType as EwalletType | undefined;
    if (!t || !(t in FEE_EWALLET)) {
      throw new Error(`Unsupported eWallet type: ${channel.ewalletType ?? '(none)'}`);
    }
    return FEE_EWALLET[t];
  }
  return 0;
}
