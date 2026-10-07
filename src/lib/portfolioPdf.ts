import { formatUGX } from '@/lib/rentCalculations';

export interface PortfolioPdfData {
  portfolioCode: string;
  accountName: string | null;
  investmentAmount: number;
  roiPercentage: number;
  roiMode: string;
  totalRoiEarned: number;
  status: string;
  createdAt: string;
  durationMonths: number;
  payoutDay?: number | null;
  nextRoiDate?: string | null;
  maturityDate?: string | null;
  ownerName?: string;
  autoReinvest?: boolean;
}

/**
 * Build the projection report as an A4 PDF. The layout lives in
 * portfolioProjectionReport.ts; html2canvas + jsPDF load on demand.
 */
export async function generatePortfolioPdf(data: PortfolioPdfData): Promise<Blob> {
  const [{ buildProjectionHtml }, { renderReportPdfBlob }, ownerName] = await Promise.all([
    import('./portfolioProjectionReport'),
    import('@/components/partner/renderAgreementPdf'),
    data.ownerName ? Promise.resolve(data.ownerName) : lookupOwnerName(data.portfolioCode),
  ]);
  return renderReportPdfBlob(buildProjectionHtml({ ...data, ownerName }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The account holder's name for the report header. Callers rarely pass it, so
 * it is read from the account's owner (works for the supporter and for staff
 * viewing a partner). Any failure just means the header says "Supporter".
 */
async function lookupOwnerName(portfolioRef: string): Promise<string | undefined> {
  try {
    const { supabase } = await import('@/integrations/supabase/client');
    const { data: acct } = await supabase
      .from('investor_portfolios')
      .select('investor_id')
      .eq(UUID.test(portfolioRef) ? 'id' : 'portfolio_code', portfolioRef)
      .maybeSingle();
    if (!acct?.investor_id) return undefined;
    const { data: prof } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', acct.investor_id)
      .maybeSingle();
    return prof?.full_name?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Download the PDF to the user's device */
export async function downloadPortfolioPdf(data: PortfolioPdfData) {
  const blob = await generatePortfolioPdf(data);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `projection-report-${(data.accountName || data.portfolioCode).replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Open WhatsApp share with a message about the portfolio */
export function sharePortfolioViaWhatsApp(data: PortfolioPdfData) {
  const displayName = data.accountName || data.portfolioCode;
  const monthlyROI = Math.round(data.investmentAmount * (data.roiPercentage / 100));
  const message = [
    `📊 *Investment Portfolio: ${displayName}*`,
    ``,
    `💰 Capital: ${formatUGX(data.investmentAmount)}`,
    `📈 ROI Rate: ${data.roiPercentage}% per month`,
    `💵 Monthly Return: ${formatUGX(monthlyROI)}`,
    `📅 Duration: ${data.durationMonths} months`,
    `🔄 Mode: ${data.roiMode === 'monthly_compounding' ? 'Compounding' : 'Monthly Payout'}`,
    `✅ Status: ${data.status === 'active' ? 'Active' : data.status === 'pending_approval' ? 'Pending Approval' : data.status}`,
    ``,
    `Total Earned So Far: ${formatUGX(data.totalRoiEarned)}`,
    ``,
    `_Welile Technologies Limited - Investment Portfolio_`,
  ].join('\n');

  const encoded = encodeURIComponent(message);
  window.open(`https://wa.me/?text=${encoded}`, '_blank');
}
