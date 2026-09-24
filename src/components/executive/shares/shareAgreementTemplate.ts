import rawHtml from './shareAgreement.html?raw';
import welileLogo from '@/assets/welile-contract-logo.png';
import { formatUGX } from '@/lib/rentCalculations';

export interface ShareAgreementData {
  participantName?: string | null;
  participantSignature?: string | null;
  participantDate?: string | null;
  adminName?: string | null;
  adminPosition?: string | null;
  adminSignature?: string | null;
  adminDate?: string | null;
  referenceId?: string | null;
  amount?: number | null;
  shares?: number | null;
  companyOwnershipPercent?: number | null;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const text = (v?: string | null) => (v && v.trim() ? esc(v.trim()) : '&nbsp;');
const sig = (url?: string | null) =>
  url && url.startsWith('data:image/')
    ? `<img src="${url}" alt="Signature" style="max-height:48px;max-width:220px;object-fit:contain;display:block;" />`
    : '&nbsp;';

export const fmtShareDate = (d?: string | Date | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '';

/** Fill the uploaded Early Angel Pool Shareholders Agreement with live values. */
export function buildShareAgreementHtml(d: ShareAgreementData): string {
  const allocation = d.referenceId
    ? `<div style="margin:0 0 14px;padding:10px 12px;border:1px solid #e9d5ff;border-radius:8px;background:#faf5ff;font-size:12px;line-height:1.6;color:#334155;">
        <strong>Share Reference:</strong> ${esc(d.referenceId)} &nbsp;•&nbsp;
        <strong>Shares:</strong> ${Number(d.shares ?? 0).toLocaleString('en-US', { maximumFractionDigits: 6 })} &nbsp;•&nbsp;
        <strong>Contribution:</strong> ${esc(formatUGX(Number(d.amount ?? 0)))} &nbsp;•&nbsp;
        <strong>Company ownership:</strong> ${Number(d.companyOwnershipPercent ?? 0).toFixed(4)}%
      </div>`
    : '';
  const admin = [d.adminName, d.adminPosition].filter(Boolean).join(', ');
  return rawHtml
    .replace(/src="logo_processed\.png"/g, `src="${welileLogo}"`)
    .replace('<h2 class="section-heading">10. Signatures</h2>', `<h2 class="section-heading">10. Signatures</h2>${allocation}`)
    .replace('{ParticipantName}', text(d.participantName))
    .replace('{ParticipantSignature}', sig(d.participantSignature))
    .replace('{ParticipantDate}', text(d.participantDate))
    .replace('{AuthorizedAdmin}', text(admin))
    .replace('{AuthorizedSignature}', sig(d.adminSignature))
    .replace('{AuthorizedDate}', text(d.adminDate));
}
