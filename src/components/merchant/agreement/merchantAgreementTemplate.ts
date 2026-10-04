import welileLogo from '@/assets/welile-contract-logo.png';
// Single source of truth for the Welile Merchant Agent Agreement: the exact HTML
// template (kept in src, never in public/). Both the on-screen preview AND the
// stored/downloaded PDF are produced from the SAME filled HTML so they render
// pixel-identically.
import RAW_TEMPLATE from './merchantAgreementTemplate.html?raw';
import { MERCHANT_AGREEMENT_VERSION } from './MerchantAgreementContent';

export interface MerchantAgreementFillData {
  merchantName?: string;
  merchantPhone?: string;
  agreementDate?: Date;
}

/** Fill the merchant agreement template with the merchant name + today's date. */
export function buildMerchantAgreementHtml(data: MerchantAgreementFillData = {}): string {
  const date = data.agreementDate ?? new Date();
  const name = (data.merchantName?.trim() || 'Merchant Agent');
  const phone = (data.merchantPhone?.trim() || '');

  const effectiveDate = date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const stampDate = date
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    .toUpperCase();

  const tokens: Record<string, string> = {
    LogoUrl: welileLogo,
    MerchantName: name,
    MerchantPhone: phone,
    EffectiveDate: effectiveDate,
    StampDate: stampDate,
    Version: MERCHANT_AGREEMENT_VERSION,
  };

  let html = RAW_TEMPLATE;
  for (const [key, value] of Object.entries(tokens)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  return html;
}
