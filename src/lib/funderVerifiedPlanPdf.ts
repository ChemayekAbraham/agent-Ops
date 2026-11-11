import welileLogoUrl from '@/assets/welile-logo.png';
import { WELILE_EMAIL_BRAND_INFO } from '@/lib/emailHeader';
import { esc, ugx } from '@/lib/welileReportDocument';
import { agreementSummary, filledTenantAgreement, type FunderVerifiedPlan } from '@/lib/funderVerifiedPlan';

/** Customer Care number Benjamin asked to print on this document. */
export const FUNDER_PLAN_CUSTOMER_CARE = '+256 777 607 640';

const shown = (v: string | null | undefined) => (v && v.trim() ? v.trim() : 'Not recorded');

function day(v: string | null | undefined): string {
  if (!v) return 'Not recorded';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return 'Not recorded';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function frequencyLabel(v: string | null): string {
  if (!v) return 'Not recorded';
  return v.replace(/_/g, ' ');
}

function row(label: string, value: string): string {
  return `<tr><td class="k">${esc(label)}</td><td class="v">${esc(value)}</td></tr>`;
}

/**
 * One branded Rent Plan document. Facts come from the dossier; this file only
 * lays them out. User-facing text has no em dash.
 */
export function buildFunderRentPlanDocument(
  plan: FunderVerifiedPlan,
  opts?: { logoSrc?: string; origin?: string },
): string {
  const logo = opts?.logoSrc || welileLogoUrl;
  const origin = opts?.origin
    || (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://welileapp.com');
  const brand = WELILE_EMAIL_BRAND_INFO;
  const repaid = plan.totalRepayment > 0
    ? `${ugx(plan.amountRepaid)} of ${ugx(plan.totalRepayment)}`
    : ugx(plan.amountRepaid);
  const momoCaption = plan.payoutMomoSource === 'approved'
    ? 'Approved payout number'
    : 'Number on the landlord record';
  const agreementBody = filledTenantAgreement(plan);

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<base href="${esc(origin)}/">
<title>Welile Rent Plan</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #ffffff; color: #0f172a; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .report-page { width: 210mm; max-width: 210mm; background: #ffffff; padding: 16px 18px 20px; }
  .head { display: flex; gap: 14px; align-items: center; border-bottom: 3px solid #7b19d4; padding-bottom: 12px; }
  .head img { width: 108px; height: auto; display: block; }
  .co { font-size: 15px; font-weight: 800; letter-spacing: 0.2px; }
  .meta { margin-top: 3px; font-size: 11px; line-height: 16px; color: #64748b; }
  .meta a { color: #7b19d4; text-decoration: none; }
  h1 { margin: 14px 0 2px; font-size: 20px; color: #7b19d4; }
  .sub { margin: 0 0 12px; font-size: 12px; color: #64748b; }
  h2 { margin: 14px 0 6px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #7b19d4; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px; vertical-align: top; }
  td.k { width: 42%; color: #64748b; }
  td.v { font-weight: 650; }
  .badge { display: inline-block; background: #16A34A; color: #ffffff; border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 700; }
  .note { margin-top: 12px; font-size: 10px; line-height: 14px; color: #64748b; }
  pre.agree { white-space: pre-wrap; font-family: inherit; font-size: 11px; line-height: 1.45; margin: 0; }
</style>
</head><body>
<article class="report-page">
  <header class="head">
    <img src="${esc(logo)}" alt="Welile" />
    <div>
      <div class="co">${esc(brand.legalName)}</div>
      <div class="meta">${esc(brand.fullPostalAddress)}</div>
      <div class="meta">Customer Care: <a href="tel:+256777607640">${FUNDER_PLAN_CUSTOMER_CARE}</a>
        &nbsp;|&nbsp; Email: <a href="mailto:${esc(brand.officialEmail)}">${esc(brand.officialEmail)}</a></div>
      <div class="meta">Website: <a href="${esc(brand.websiteUrl)}">${esc(brand.websiteDomain)}</a>
        &nbsp;|&nbsp; App: <a href="${esc(brand.appUrl)}">${esc(brand.appDomain)}</a></div>
    </div>
  </header>
  <h1>Rent Plan</h1>
  <p class="sub">Verification <span class="badge">${esc(plan.verificationLabel || 'Recorded')}</span></p>
  <h2>Tenant</h2>
  <table>
    ${row('Name', plan.tenantName)}
    ${row('Phone', shown(plan.tenantPhone))}
    ${row('House', shown(plan.houseCategory))}
    ${row('Location', shown(plan.location))}
  </table>
  <h2>Landlord</h2>
  <table>
    ${row('Name', plan.landlordName)}
    ${row('Phone', shown(plan.landlordPhone))}
  </table>
  <h2>Mobile money payout</h2>
  <table>
    ${row(momoCaption, shown(plan.payoutMomoNumber))}
    ${row('Name on the account', shown(plan.payoutMomoName))}
  </table>
  <h2>Rent and repayment</h2>
  <table>
    ${row('Rent amount', ugx(plan.rentAmount))}
    ${row('Daily repayment', ugx(plan.dailyRepayment))}
    ${row('Total repayment', ugx(plan.totalRepayment))}
    ${row('Repaid so far', repaid)}
    ${row('Duration', plan.durationDays ? `${plan.durationDays} days` : 'Not recorded')}
    ${row('Frequency', frequencyLabel(plan.repaymentFrequency))}
    ${row('Repayment starts', day(plan.repaymentStartsOn))}
    ${row('Funded on', day(plan.fundedAt))}
  </table>
  ${plan.funding ? `<h2>Where this rent is</h2><table>${row('Route', plan.funding.routeDetail || 'Not recorded')}${plan.funding.agentName ? row('Agent', plan.funding.agentName) : ''}</table>` : ''}
  ${plan.verified ? `<h2>Tenant Partnership Agreement</h2>
  <table>
    ${row('Summary', agreementSummary(plan))}
  </table>
  <pre class="agree">${esc(agreementBody)}</pre>` : ''}
  <p class="note">${esc(brand.legalName)}. This copy is for the Supporter funding this verified Rent Plan. It does not move money.</p>
</article>
</body></html>`;
}

export async function downloadFunderRentPlanPdf(plan: FunderVerifiedPlan): Promise<void> {
  const { renderReportPdfBlob } = await import('@/components/partner/renderAgreementPdf');
  const blob = await renderReportPdfBlob(buildFunderRentPlanDocument(plan), { a4Sheets: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `welile-rent-plan-${plan.rentRequestId.slice(0, 8)}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function openPrint(html: string): boolean {
  const win = window.open('', '_blank', 'noopener,noreferrer');
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  const go = () => {
    win.focus();
    win.print();
  };
  if (win.document.readyState === 'complete') setTimeout(go, 250);
  else win.addEventListener('load', () => setTimeout(go, 250), { once: true });
  return true;
}

/** Opens the same document and asks the browser to print it. Phones can save that as a PDF too. */
export function printFunderRentPlan(plan: FunderVerifiedPlan): boolean {
  return openPrint(buildFunderRentPlanDocument(plan));
}

/** Branded receipt for the rent the Supporter paid through Welile. Wording comes from the server route. */
export function buildFunderRentReceiptDocument(
  plan: FunderVerifiedPlan,
  opts?: { logoSrc?: string; origin?: string; coverFeeCharged?: number | null },
): string {
  const funding = plan.funding;
  const logo = opts?.logoSrc || welileLogoUrl;
  const origin = opts?.origin
    || (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://welileapp.com');
  const brand = WELILE_EMAIL_BRAND_INFO;
  const route = funding?.routeDetail || 'Your funding is recorded. A payout route is not on file yet.';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<base href="${esc(origin)}/">
<title>Welile rent receipt</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #ffffff; color: #0f172a; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .report-page { width: 210mm; max-width: 210mm; background: #ffffff; padding: 16px 18px 20px; }
  .head { display: flex; gap: 14px; align-items: center; border-bottom: 3px solid #7b19d4; padding-bottom: 12px; }
  .head img { width: 108px; height: auto; display: block; }
  .co { font-size: 15px; font-weight: 800; }
  .meta { margin-top: 3px; font-size: 11px; line-height: 16px; color: #64748b; }
  .meta a { color: #7b19d4; text-decoration: none; }
  h1 { margin: 14px 0 4px; font-size: 20px; color: #7b19d4; }
  .sub { margin: 0 0 12px; font-size: 12px; color: #64748b; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px; vertical-align: top; }
  td.k { width: 42%; color: #64748b; }
  td.v { font-weight: 650; }
  .note { margin-top: 12px; font-size: 10px; line-height: 14px; color: #64748b; }
</style>
</head><body>
<article class="report-page">
  <header class="head">
    <img src="${esc(logo)}" alt="Welile" />
    <div>
      <div class="co">${esc(brand.legalName)}</div>
      <div class="meta">${esc(brand.fullPostalAddress)}</div>
      <div class="meta">Customer Care: <a href="tel:+256777607640">${FUNDER_PLAN_CUSTOMER_CARE}</a>
        &nbsp;|&nbsp; Email: <a href="mailto:${esc(brand.officialEmail)}">${esc(brand.officialEmail)}</a></div>
      <div class="meta">Website: <a href="${esc(brand.websiteUrl)}">${esc(brand.websiteDomain)}</a>
        &nbsp;|&nbsp; App: <a href="${esc(brand.appUrl)}">${esc(brand.appDomain)}</a></div>
    </div>
  </header>
  <h1>Receipt for rent paid through Welile</h1>
  <p class="sub">This receipt records your funding. It does not move money.</p>
  <table>
    ${row('Receipt number', shown(funding?.receiptNumber))}
    ${row('Date', day(funding?.recordedAt || plan.fundedAt))}
    ${row('Supporter', shown(funding?.funderName))}
    ${row('Tenant', plan.tenantName)}
    ${row('House', shown(plan.houseTitle || plan.houseCategory))}
    ${row('Landlord', plan.landlordName)}
    ${row('Amount', ugx(funding?.amount ?? plan.rentAmount))}
    ${row('Payout route', route)}
    ${row('Agent', shown(funding?.agentName))}
    ${row('Reference', shown(funding?.reference))}
    ${funding?.tid ? row('TID', funding.tid) : ''}
    ${(opts?.coverFeeCharged ?? 0) > 0 ? row('Welile Cover', `${ugx(opts?.coverFeeCharged)} charged from your Welile wallet`) : ''}
  </table>
  <p class="note">${esc(brand.legalName)}. Customer Care ${FUNDER_PLAN_CUSTOMER_CARE}.</p>
</article>
</body></html>`;
}

export async function downloadFunderRentReceiptPdf(plan: FunderVerifiedPlan, coverFeeCharged?: number | null): Promise<void> {
  const { renderReportPdfBlob } = await import('@/components/partner/renderAgreementPdf');
  const blob = await renderReportPdfBlob(buildFunderRentReceiptDocument(plan, { coverFeeCharged }), { a4Sheets: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `welile-rent-receipt-${(plan.funding?.receiptNumber || plan.rentRequestId.slice(0, 8)).replace(/[^A-Za-z0-9-]+/g, '')}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function printFunderRentReceipt(plan: FunderVerifiedPlan, coverFeeCharged?: number | null): boolean {
  return openPrint(buildFunderRentReceiptDocument(plan, { coverFeeCharged }));
}
