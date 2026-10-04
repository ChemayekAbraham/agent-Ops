import agreementTemplate from '@/assets/Welile_12_Month_Landlord_Rent_Agreement.pdf.asset.json';

export type LandlordAgreementTemplateInput = {
  landlordName?: string | null;
  landlordPhone?: string | null;
  propertyAddress?: string | null;
  monthlyRent?: number | null;
  nin?: string | null;
  houseNumber?: string | null;
  paymentDay?: string | number | null;
};

/**
 * Downloads the exact approved 12-month landlord agreement supplied by Welile.
 * The input parameter remains accepted for callers that previously supplied
 * prefill data, but the approved template is intentionally never rewritten.
 */
export function downloadLandlordAgreementTemplate(_input: LandlordAgreementTemplateInput = {}) {
  const link = document.createElement('a');
  link.href = agreementTemplate.url;
  link.download = 'Welile_12_Month_Landlord_Rent_Agreement.pdf';
  link.target = '_blank';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
