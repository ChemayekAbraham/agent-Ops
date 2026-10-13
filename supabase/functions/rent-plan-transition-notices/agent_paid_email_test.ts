// The AP email, rendered. messages_test.ts proves the figures are right; this
// proves the template turns them into something an agent can read: the receipt
// number and code are on the page, the button points at the public receipt, and
// the parts that may be missing (commission, instalment) leave no hole.
//
//   deno test --allow-env --allow-net supabase/functions/rent-plan-transition-notices/agent_paid_email_test.ts

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import * as React from 'npm:react@18.3.1';
import { renderAsync } from 'npm:@react-email/components@0.0.22';
import { TEMPLATES } from '../_shared/transactional-email-templates/registry.ts';
import { agentPaidEmailData } from './index.ts';

const notice = {
  rent_request_id: '2d6e0c1a-0000-4000-8000-000000000001',
  agent_id: 'a1', agent_email: 'agent@example.com',
  agent_name: 'PIUSLUBEGA SSENKALI', landlord_name: 'Don Adrew kagwa',
  tenant_name: 'Susan Sandra Namiilo', rent_amount: 800000,
  instalment: 36000, period_label: 'per day',
  repayment_starts_on: '2026-10-13',
  receipt_number: 'WLR-101212', receipt_code: '4N2X3GDHAE',
  paid_at: '2026-10-09T07:42:46.263+00:00',
  commission_ugx: 8000 as number | null, ref: '2D6E0C1A',
};

const render = async (n = notice) => {
  const t = TEMPLATES['agent-landlord-paid-receipt'];
  const data = agentPaidEmailData(n);
  const html = await renderAsync(React.createElement(t.component, data));
  const text = await renderAsync(React.createElement(t.component, data), { plainText: true });
  const subject = typeof t.subject === 'function' ? t.subject(data) : t.subject;
  return { html, text, subject };
};

Deno.test('the template is registered under the name the function sends', () => {
  assert(TEMPLATES['agent-landlord-paid-receipt'], 'agent-landlord-paid-receipt missing from the registry');
});

Deno.test('AP email shows the receipt number and code, and links to the receipt', async () => {
  const { html, text } = await render();
  for (const page of [html, text]) {
    assertStringIncludes(page, 'WLR-101212');
    assertStringIncludes(page, '4N2X3GDHAE');
    assertStringIncludes(page, 'Don Adrew kagwa');
    assertStringIncludes(page, 'UGX 800,000');
  }
  assertStringIncludes(html, 'href="https://welileapp.com/r/4N2X3GDHAE"');
});

Deno.test('AP email subject leads with the receipt number', async () => {
  const { subject } = await render();
  assertEquals(subject, 'Receipt WLR-101212: UGX 800,000 paid to Don Adrew kagwa');
});

Deno.test('AP email says what happens next, with the commission', async () => {
  const { text } = await render();
  assertStringIncludes(text, 'Susan Sandra Namiilo');
  assertStringIncludes(text, 'Tuesday 13 October');
  assertStringIncludes(text, 'UGX 36,000');
  assertStringIncludes(text, 'UGX 8,000');
  assertStringIncludes(text, 'Please upload the receipt.');
});

// An agent is never told they earned money that was not posted - the same rule
// as the SMS.
Deno.test('AP email makes no commission claim when none was posted', async () => {
  const { text } = await render({ ...notice, commission_ugx: null });
  assert(!/commission/i.test(text), 'the email mentions commission although none was posted');
});

// The email must read as a Rent Plan, never a loan.
Deno.test('AP email uses the regulatory terminology', async () => {
  const { text } = await render();
  assertStringIncludes(text, 'Rent Plan');
  assert(!/\bloan\b|\blender\b|\binterest\b|\bROI\b/i.test(text), 'forbidden terminology in the email');
});
