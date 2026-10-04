import { formatUGX } from './rentCalculations';
import { getRiskTierLabel } from './welileAiId';
import { buildProfileShareUrl } from './shareTrustProfile';
import welileLogoUrl from '@/assets/welile-logo.png';
import type { TrustProfile } from '@/hooks/useTrustProfile';

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Lender-grade PDF version of the holistic profile */
export async function generateTrustProfilePdf(profile: TrustProfile): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const margin = 16;
  const cw = pw - margin * 2;
  let y = 14;

  // ── Header ──
  const logo = await loadLogoBase64();
  if (logo) pdf.addImage(logo, 'PNG', margin, y - 4, 14, 14);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(13);
  pdf.text('Welile Trust Profile', margin + 18, y + 3);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(100);
  pdf.text("Africa's rent trust network", margin + 18, y + 8);
  pdf.setTextColor(0);

  // AI ID (top right)
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.text(profile.ai_id, pw - margin, y + 3, { align: 'right' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7);
  pdf.setTextColor(120);
  pdf.text(`Generated ${new Date().toLocaleDateString('en-UG')}`, pw - margin, y + 8, { align: 'right' });
  pdf.setTextColor(0);

  y += 16;
  pdf.setDrawColor(220);
  pdf.line(margin, y, pw - margin, y);
  y += 6;

  // ── Identity ──
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(15);
  pdf.text(profile.identity.full_name, margin, y);
  y += 6;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(80);
  const memberSince = new Date(profile.identity.member_since).toLocaleDateString('en-UG', {
    month: 'long', year: 'numeric',
  });
  pdf.text(
    `${profile.identity.primary_role.replace(/_/g, ' ')} • Member since ${memberSince}${
      profile.identity.verified ? ' • Verified ✓' : ''
    }`,
    margin,
    y,
  );
  pdf.setTextColor(0);
  y += 8;

  // ── Trust Score Hero ──
  const tier = getRiskTierLabel(profile.trust.tier);
  pdf.setFillColor(245, 247, 252);
  pdf.roundedRect(margin, y, cw, 30, 3, 3, 'F');

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(28);
  pdf.text(String(profile.trust.score), margin + 8, y + 18);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(120);
  pdf.text('/ 100', margin + 8, y + 24);
  pdf.setTextColor(0);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.text('Welile Trust Score', margin + 38, y + 9);
  pdf.setFontSize(13);
  pdf.text(tier.label, margin + 38, y + 17);
  if (profile.trust.borrowing_limit_ugx > 0) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(0, 130, 80);
    pdf.text(`Welile vouches up to ${formatUGX(profile.trust.borrowing_limit_ugx)}`, margin + 38, y + 24);
    pdf.setTextColor(0);
  }
  y += 36;

  // ── Score Breakdown ──
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text('Score Breakdown', margin, y);
  y += 5;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);

  const breakdownRows: [string, number, number][] = [
    ['Payment Behavior', profile.trust.weights.payment, profile.trust.breakdown.payment],
    ['Wallet Activity', profile.trust.weights.wallet, profile.trust.breakdown.wallet],
    ['Network & Contribution', profile.trust.weights.network, profile.trust.breakdown.network],
    ['Verification', profile.trust.weights.verification, profile.trust.breakdown.verification],
  ];
  for (const [label, weight, score] of breakdownRows) {
    pdf.text(`${label} (${weight}%)`, margin, y);
    pdf.text(String(Math.round(score)), pw - margin, y, { align: 'right' });
    // bar
    pdf.setFillColor(230, 230, 240);
    pdf.rect(margin, y + 1, cw, 1.5, 'F');
    pdf.setFillColor(70, 100, 220);
    pdf.rect(margin, y + 1, (cw * score) / 100, 1.5, 'F');
    y += 6;
  }

  y += 4;

  // ── Payment History ──
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text('Payment History', margin, y);
  y += 5;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  const ph = profile.payment_history;
  const phRows: [string, string][] = [
    ['Total rent plans', String(ph.total_rent_plans)],
    ['On-time rate', `${ph.on_time_rate}%`],
    ['Total repaid', formatUGX(ph.total_repaid)],
    ['Outstanding', formatUGX(ph.total_owing)],
  ];
  for (const [k, v] of phRows) {
    pdf.text(k, margin, y);
    pdf.text(v, pw - margin, y, { align: 'right' });
    y += 5;
  }
  y += 3;

  // ── Network ──
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text('Network & Contribution', margin, y);
  y += 5;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  const nRows: [string, string][] = [
    ['Referrals', String(profile.network.referrals)],
    ['Sub-agents', String(profile.network.sub_agents)],
    ['Roles', profile.identity.roles.join(', ')],
  ];
  for (const [k, v] of nRows) {
    pdf.text(k, margin, y);
    pdf.text(v, pw - margin, y, { align: 'right', maxWidth: cw / 2 });
    y += 5;
  }

  // ── Footer ──
  const footY = pdf.internal.pageSize.getHeight() - 18;
  pdf.setDrawColor(220);
  pdf.line(margin, footY - 4, pw - margin, footY - 4);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7);
  pdf.setTextColor(120);
  const url = buildProfileShareUrl(profile.ai_id);
  pdf.text(
    'Informational summary only. Not a credit report or financial advice. Backed by Welile AI Insurance.',
    margin,
    footY,
    { maxWidth: cw },
  );
  pdf.text(url, margin, footY + 6);
  pdf.setTextColor(0);

  return pdf.output('blob');
}
