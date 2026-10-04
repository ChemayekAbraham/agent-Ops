import { assertEquals, assertStrictEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  buildPartnershipEmailRequest,
  shouldSendPartnershipEmail,
} from './partnership-email.ts';

const baseCtx = {
  portfolioCreatedThisRun: true,
  recipientEmail: 'pexpert46@gmail.com',
  userId: 'user-abc',
  newPortfolioId: 'portfolio-xyz',
  partnerName: 'Pius Expert',
  amount: 1_000_000,
  monthlyReward: 150_000,
  contributionDateIso: '2026-04-21T10:00:00.000Z',
  firstPayoutDateIso: '2026-05-21',
  payoutDay: 21,
};

Deno.test('shouldSendPartnershipEmail: sends when a NEW portfolio is created', () => {
  assertStrictEquals(
    shouldSendPartnershipEmail({
      portfolioCreatedThisRun: true,
      recipientEmail: 'pexpert46@gmail.com',
    }),
    true,
  );
});

Deno.test('shouldSendPartnershipEmail: does NOT send for pending_portfolio_topup (no new portfolio)', () => {
  // Mid-cycle top-ups parked into pending_portfolio_topup never set
  // portfolioCreatedThisRun=true, so the gate must reject.
  assertStrictEquals(
    shouldSendPartnershipEmail({
      portfolioCreatedThisRun: false,
      recipientEmail: 'pexpert46@gmail.com',
    }),
    false,
  );
});

Deno.test('shouldSendPartnershipEmail: does NOT send when recipient email missing', () => {
  assertStrictEquals(
    shouldSendPartnershipEmail({
      portfolioCreatedThisRun: true,
      recipientEmail: null,
    }),
    false,
  );
  assertStrictEquals(
    shouldSendPartnershipEmail({
      portfolioCreatedThisRun: true,
      recipientEmail: '',
    }),
    false,
  );
});

Deno.test('buildPartnershipEmailRequest: returns null when gate is closed', () => {
  const req = buildPartnershipEmailRequest({
    ...baseCtx,
    portfolioCreatedThisRun: false,
  });
  assertStrictEquals(req, null);
});

Deno.test('buildPartnershipEmailRequest: returns null when email missing', () => {
  const req = buildPartnershipEmailRequest({ ...baseCtx, recipientEmail: undefined });
  assertStrictEquals(req, null);
});

Deno.test('buildPartnershipEmailRequest: idempotency key includes new portfolio id', () => {
  const req = buildPartnershipEmailRequest(baseCtx)!;
  assertEquals(
    req.idempotencyKey,
    'partnership-agreement-user-abc-portfolio-xyz',
  );
});

Deno.test('buildPartnershipEmailRequest: idempotency key DIFFERS across distinct new portfolios', () => {
  const a = buildPartnershipEmailRequest({ ...baseCtx, newPortfolioId: 'p-1' })!;
  const b = buildPartnershipEmailRequest({ ...baseCtx, newPortfolioId: 'p-2' })!;
  if (a.idempotencyKey === b.idempotencyKey) {
    throw new Error('Distinct new portfolios must produce distinct idempotency keys');
  }
});

Deno.test('buildPartnershipEmailRequest: template data is derived from the funded amount', () => {
  const req = buildPartnershipEmailRequest(baseCtx)!;
  assertEquals(req.templateName, 'partnership-agreement');
  assertEquals(req.recipientEmail, 'pexpert46@gmail.com');
  assertEquals(req.templateData.partnership_amount, 1_000_000);
  assertEquals(req.templateData.monthly_return_amount, 150_000);
  // Total projected = monthly * 12
  assertEquals(req.templateData.total_projected_return, 150_000 * 12);
  assertEquals(req.templateData.roi_payment_day, 21);
  assertEquals(req.templateData.currency, 'UGX');
  assertEquals(req.templateData.partner_name, 'Pius Expert');
});

Deno.test('buildPartnershipEmailRequest: falls back to "Partner" when name missing', () => {
  const req = buildPartnershipEmailRequest({ ...baseCtx, partnerName: null })!;
  assertEquals(req.templateData.partner_name, 'Partner');
});

Deno.test('buildPartnershipEmailRequest: dates are formatted long-form (en-GB)', () => {
  const req = buildPartnershipEmailRequest(baseCtx)!;
  assertEquals(req.templateData.contribution_date, '21 April 2026');
  assertEquals(req.templateData.first_payment_date, '21 May 2026');
});
