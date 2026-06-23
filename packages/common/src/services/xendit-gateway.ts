import type { CreateInvoiceRequest, Invoice as InvoiceModel } from 'xendit-node/invoice/models';
import { getXenditClient } from './xendit.client';

/**
 * Thin port over the Xendit Node SDK. Lets PaymentService stay testable —
 * tests inject a fake gateway, runtime uses {@link RealXenditGateway}.
 *
 * Flow uses the Invoice API (hosted checkout) — Xendit hosts the UI for VA /
 * eWallet / CC; mobile loads `invoiceUrl` in a WebView. Backend stays channel-agnostic.
 */
export interface XenditGateway {
  createInvoice(params: CreateInvoiceRequest): Promise<InvoiceModel>;
  expireInvoice(invoiceId: string): Promise<InvoiceModel>;
}

export class RealXenditGateway implements XenditGateway {
  async createInvoice(params: CreateInvoiceRequest): Promise<InvoiceModel> {
    const client = getXenditClient();
    return client.Invoice.createInvoice({ data: params });
  }

  async expireInvoice(invoiceId: string): Promise<InvoiceModel> {
    const client = getXenditClient();
    return client.Invoice.expireInvoice({ invoiceId });
  }
}

export const xenditGateway: XenditGateway = new RealXenditGateway();
