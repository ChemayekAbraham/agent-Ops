import { numberToWords } from '@/lib/numberToWords';
import welileLogo from '@/assets/welile-contract-logo.png';
// Single source of truth: the exact partner contract template (kept in src, never
// in public/). Both the on-screen preview AND the stored/emailed PDF are produced
// from the SAME filled HTML so they render pixel-identically.
import RAW_TEMPLATE from './partnerAgreementTemplate.html?raw';

export interface AgreementFillData {
  partnerName: string;
  partnerId?: string;
  partnerAddress?: string;
  partnerPhone?: string;
  partnerEmail?: string;
  partnershipAmount: number;
  /** Monthly return percentage printed in the returns clause (default 15). */
  returnPercentage?: number;
  payoutMode?: 'bank' | 'momo';
  bankName?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
  momoProvider?: string;
  momoNumber?: string;
  momoName?: string;
  kinName?: string;
  kinContact?: string;
  agreementDate?: Date;
  welileRepName?: string;
  welileRepPosition?: string;
  welileRepContact?: string;
  welileSignatureDataUrl?: string;
  partnerSignatureDataUrl?: string;
  /**
   * The Welile company stamp is ONLY applied to executed/counter-signed
   * agreements from Partner Ops. Draft agreements sent from /funder-onboarding
   * must not carry the stamp.
   */
  includeStamp?: boolean;
}

function ordinal(day: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = day % 100;
  return day + (s[(v - 20) % 10] || s[v] || s[0]);
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Dynamic e-stamp matching the physical Welile Technologies stamp: a single
// solid blue rounded rectangle with the company name, a star–date–star row
// (red date) and the postal address. Injected as inline HTML so html2canvas
// captures it identically to the on-screen preview.
function stampHtml(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = date.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase();
  const year = date.getFullYear();
  return `
  <div style="position:absolute; top:50%; right:72px; transform:translateY(-50%) rotate(-37deg) scale(0.64); transform-origin:right center; opacity:0.82; pointer-events:none; z-index:5;">
    <div style="width:340px; border:5px solid #1134a6; border-radius:12px; padding:16px 20px; text-align:center; background:transparent; box-sizing:border-box;">
      <div style="color:#1134a6; font-family:'Crimson Text','Times New Roman',serif; font-weight:700; font-size:20px; line-height:1.12; letter-spacing:1px; margin-bottom:12px; white-space:nowrap;">WELILE TECHNOLOGIES<br>LIMITED</div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding:0 6px;">
        <span style="color:#1134a6; font-size:28px; line-height:1;">&#9733;</span>
        <span style="color:#e51921; font-family:'Oswald','Arial Narrow',Arial,sans-serif; font-size:28px; font-weight:600; letter-spacing:1.5px; white-space:nowrap;">${day} ${month} ${year}</span>
        <span style="color:#1134a6; font-size:28px; line-height:1;">&#9733;</span>
      </div>
      <div style="color:#1134a6; font-family:'Nunito','Trebuchet MS',sans-serif; font-size:15px; font-weight:700; letter-spacing:0.5px; white-space:nowrap;">PO Box 167564 Kampala Uganda</div>
    </div>
  </div>`;
}

/**
 * Fill the contract template with partner + Welile counter-signature details.
 * Returns a complete standalone HTML document string.
 */
export function buildAgreementHtml(data: AgreementFillData): string {
  const date = data.agreementDate ?? new Date();
  const day = date.getDate();
  const month = date.toLocaleString('en-GB', { month: 'long' });

  const name = esc(data.partnerName?.trim() || '');
  const amountNum = Math.max(0, Math.floor(data.partnershipAmount || 0));
  const amountStr = amountNum.toLocaleString('en-US');
  const amountWords = `${numberToWords(amountNum)} Shillings`;

  const isBank = data.payoutMode !== 'momo';
  const bankName = isBank
    ? esc(data.bankName?.trim() || '')
    : esc(`${data.momoProvider?.trim() || 'Mobile Money'} (Mobile Money)`);
  const accName = isBank ? esc(data.bankAccountName?.trim() || '') : esc(data.momoName?.trim() || '');
  const accNo = isBank ? esc(data.bankAccountNumber?.trim() || '') : esc(data.momoNumber?.trim() || '');

  // Signature renderers: image when supplied, otherwise blank (Welile) or an
  // italic typed name (partner) — mirroring the prior behaviour.
  const welileSig = data.welileSignatureDataUrl
    ? `<img src="${data.welileSignatureDataUrl}" alt="Signature" style="max-height:40px; max-width:180px; object-fit:contain;" />`
    : '';
  const partnerSig = data.partnerSignatureDataUrl
    ? `<img src="${data.partnerSignatureDataUrl}" alt="Signature" style="max-height:40px; max-width:180px; object-fit:contain;" />`
    : (name ? `<span style="font-style:italic; font-weight:400;">${name.toLowerCase()}</span>` : '');
  // Next of kin signs as a typed italic lowercase name (no captured signature image).
  const kinNameRaw = data.kinName?.trim() || '';
  const kinSig = kinNameRaw
    ? `<span style="font-style:italic; font-weight:400;">${esc(kinNameRaw.toLowerCase())}</span>`
    : '';
  const stamp = data.includeStamp ? stampHtml(date) : '';


  const tokens: Record<string, string> = {
    LogoUrl: welileLogo,
    PartnerName: name,
    PartnerID: esc(data.partnerId?.trim() || ''),
    PartnerAddress: esc(data.partnerAddress?.trim() || ''),
    PartnerPhone: esc(data.partnerPhone?.trim() || ''),
    PartnerEmail: esc(data.partnerEmail?.trim() || ''),
    PartnershipAmount: esc(amountStr),
    PartnershipAmountWords: esc(amountWords),
    ReturnPercentage: esc(
      Number.isFinite(Number(data.returnPercentage)) && Number(data.returnPercentage) > 0
        ? String(Number(Number(data.returnPercentage).toFixed(2)))
        : '15',
    ),
    AgreementDay: esc(ordinal(day)),
    AgreementMonth: esc(month),
    WelileRepName: esc(data.welileRepName?.trim() || ''),
    WelileRepPosition: esc(data.welileRepPosition?.trim() || ''),
    WelileRepContact: esc(data.welileRepContact?.trim() || ''),
    WelileSignature: welileSig,
    PartnerSignature: partnerSig,
    BankName: bankName,
    BankAccountName: accName,
    BankAccountNumber: accNo,
    KinName: esc(data.kinName?.trim() || ''),
    KinContact: esc(data.kinContact?.trim() || ''),
    KinSignature: kinSig,

    // Stamp appears only on executed/counter-signed agreements, centered on the
    // right side of every page with enough inner margin to prevent rotation clipping.
    CoverStamp: stamp,
    StampOverlay: stamp,
    StampPage: stamp,
  };

  let html = RAW_TEMPLATE;
  for (const [key, value] of Object.entries(tokens)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  return html;
}
