import { assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';

// Functions that handle pending_portfolio_topup flows. None of them should
// enqueue the partnership-agreement email — that template fires only when a
// brand-new investor_portfolios row is created (fund-rent-pool).
const TOPUP_FUNCTIONS = [
  'portfolio-topup',
  'manager-portfolio-topup',
  'coo-wallet-to-portfolio',
  'approve-portfolio-topup',
  'merge-pending-topups',
  'cancel-pending-topups',
];

for (const fn of TOPUP_FUNCTIONS) {
  Deno.test(`top-up function "${fn}" does NOT enqueue partnership-agreement email`, async () => {
    const path = new URL(`../${fn}/index.ts`, import.meta.url);
    const source = await Deno.readTextFile(path);
    // Look for the template name as a string literal value (quoted), not as
    // a substring inside comments or unrelated identifiers. The partnership-
    // agreement template must NEVER be enqueued from a top-up flow.
    const enqueuesPartnershipAgreement =
      source.includes('"partnership-agreement"') ||
      source.includes("'partnership-agreement'") ||
      source.includes('`partnership-agreement');
    assert(
      !enqueuesPartnershipAgreement,
      `Top-up function "${fn}" must not reference the partnership-agreement template; ` +
        `mid-cycle top-ups parked into pending_portfolio_topup must not trigger the email.`,
    );
    assert(
      !source.includes('buildPartnershipEmailRequest'),
      `Top-up function "${fn}" must not call buildPartnershipEmailRequest.`,
    );
  });
}
