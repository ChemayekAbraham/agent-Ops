// Pure helpers for the partnership-agreement email triggered by fund-rent-pool.
// Extracted so the gate + payload shape can be unit-tested without spinning up
// the full Deno.serve handler or hitting the network.

export interface PartnershipEmailContext {
  portfolioCreatedThisRun: boolean;
  recipientEmail: string | null | undefined;
  userId: string;
  newPortfolioId: string;
  partnerName: string | null | undefined;
  amount: number;
  monthlyReward: number;
  contributionDateIso: string;     // ISO string of the funding moment
  firstPayoutDateIso: string;      // YYYY-MM-DD or ISO
  payoutDay: number;
}

export interface PartnershipEmailRequest {
  templateName: 'partnership-agreement';
  recipientEmail: string;
  idempotencyKey: string;
  templateData: {
    partner_name: string;
    partnership_amount: number;
    contribution_date: string;
    monthly_return_amount: number;
    total_projected_return: number;
    first_payment_date: string;
    roi_payment_day: number;
    currency: 'UGX';
    company_name: string;
    logo_url: string;
    dashboard_url: string;
  };
}

export function formatLongDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Decides whether to send the partnership-agreement email.
 * MUST mirror the production gate in fund-rent-pool/index.ts.
 *
 * Rule: send only when this run created a NEW investor_portfolios row.
 * Mid-cycle top-ups parked into pending_portfolio_topup do NOT create a new
 * portfolio row in this function, so they MUST NOT trigger the email.
 */
export function shouldSendPartnershipEmail(
  ctx: Pick<PartnershipEmailContext, 'portfolioCreatedThisRun' | 'recipientEmail'>,
): boolean {
  return ctx.portfolioCreatedThisRun === true && !!ctx.recipientEmail;
}

export function buildPartnershipEmailRequest(
  ctx: PartnershipEmailContext,
): PartnershipEmailRequest | null {
  if (!shouldSendPartnershipEmail(ctx)) return null;
  const totalProjected = ctx.monthlyReward * 12;
  return {
    templateName: 'partnership-agreement',
    recipientEmail: ctx.recipientEmail!,
    idempotencyKey: `partnership-agreement-${ctx.userId}-${ctx.newPortfolioId}`,
    templateData: {
      partner_name: ctx.partnerName || 'Partner',
      partnership_amount: ctx.amount,
      contribution_date: formatLongDate(ctx.contributionDateIso),
      monthly_return_amount: ctx.monthlyReward,
      total_projected_return: totalProjected,
      first_payment_date: formatLongDate(ctx.firstPayoutDateIso),
      roi_payment_day: ctx.payoutDay,
      currency: 'UGX',
      company_name: 'Welile',
      logo_url: 'https://welileapp.com/welile-logo.png',
      dashboard_url: 'https://welileapp.com/auth',
    },
  };
}
