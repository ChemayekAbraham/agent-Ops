import { MERCHANT_AGREEMENT_VERSION } from './MerchantAgreementContent';
import { buildMerchantAgreementHtml } from './merchantAgreementTemplate';
import { renderAgreementPdfBase64 } from '@/components/partner/renderAgreementPdf';

/**
 * Renders the Welile Merchant Agent Agreement from the SAME HTML template used
 * on screen into a multi-page A4 PDF and triggers a browser download. The PDF is
 * therefore pixel-identical to the preview.
 */
export async function downloadMerchantAgreementPdf(opts?: { name?: string; phone?: string }) {
  const merchantName = opts?.name?.trim() || opts?.phone?.trim() || 'Merchant Agent';
  const html = buildMerchantAgreementHtml({
    merchantName,
    merchantPhone: opts?.phone,
    agreementDate: new Date(),
  });

  const base64 = await renderAgreementPdfBase64(html);
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'application/pdf' });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Welile_Merchant_Agent_Agreement_${MERCHANT_AGREEMENT_VERSION}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
