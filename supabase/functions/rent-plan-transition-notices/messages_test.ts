// The messages in this file are the SPEC, copied from section 5 of
// docs/rent-plan-new-flow-full-report.md. The test asserts that what the
// function actually renders is identical to it.
//
// This exists because "it matches the document" was asserted twice and was
// wrong twice — once with the deadline missing from A1 entirely, once with an
// invented fallback branch still carrying the old wording. An assertion that
// nobody can check is worth nothing. Run it:
//
//   deno test --allow-none supabase/functions/rent-plan-transition-notices/messages_test.ts
//
// ONE JUDGEMENT CALL, STATED OPENLY. The document wraps its message blocks at
// roughly 70 characters for readability, which puts a line break mid-sentence
// in A1 ("...to your wallet for\n{landlord_name}"), A3, A4, T1 and T2. Those
// are soft wraps in a markdown file, not intended breaks in an SMS — a text
// message that broke mid-phrase would read as a mistake. BLANK LINES, which
// separate paragraphs and carry meaning, are preserved exactly; the indented
// block in T1 is preserved exactly. The comparison therefore collapses single
// newlines inside a paragraph and compares everything else character for
// character. If the document means those breaks literally, change `unwrap`
// below to the identity function and the test will tell you what moves.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  agentMessage,
  agentNudgeMessage,
  agentPaidMessage,
  agentPaidEmailData,
  agentCancelledMessage,
  tenantMessage,
  tenantCancelledMessage,
} from './index.ts';

/** Collapse the document's soft wrapping; keep paragraph breaks and indents. */
const unwrap = (s: string) =>
  s
    .split('\n\n')
    .map((para) =>
      para.includes('\n  ') // an indented block is deliberate layout, leave it
        ? para
        : para.replace(/\n(?!\s)/g, ' '),
    )
    .join('\n\n')
    .trim();

const same = (label: string, actual: string, spec: string) =>
  assertEquals(unwrap(actual), unwrap(spec), `${label} does not match the document`);

/* ------------------------------------------------------------------ *
 * To the agent
 * ------------------------------------------------------------------ */

Deno.test('A1 matches the document', () => {
  const actual = agentMessage({
    rent_request_id: 'r1', agent_id: 'a1', agent_phone: '+256700000000',
    agent_name: 'TIMOTHY', landlord_name: 'John Kibalama', tenant_name: 'Aaron Gwokto',
    rent_amount: 100000, ref: '9C078BF7',
    deadline_time: '16:43', deadline_date: 'Tuesday 29 September', recall_active: true,
  });

  same('A1', actual, `UGX 100,000 landlord float has been sent to your wallet for
John Kibalama (Aaron Gwokto).

Pay the landlord within 24 hours — by 16:43 on Tuesday 29 September —
or the float will be returned and the Rent Plan cancelled.

Payouts run 06:00–22:00. Ref 9C078BF7.`);
});

Deno.test('A3 matches the document', () => {
  const actual = agentNudgeMessage({
    rent_request_id: 'r1', agent_id: 'a1', agent_phone: '+256700000000',
    agent_name: 'TIMOTHY', landlord_name: 'John Kibalama', tenant_name: 'Aaron Gwokto',
    amount: 100000, deadline_date: '', severity: 'warning', hours_left: 6,
    ref: '9C078BF7', deadline_time: '16:43',
  });

  same('A3', actual, `Reminder: UGX 100,000 for landlord John Kibalama is still in your
wallet. You have 6 hours left (16:43). After that the float is
returned and Aaron Gwokto's Rent Plan is cancelled. Ref 9C078BF7.`);
});

Deno.test('A4 matches the document', () => {
  const actual = agentCancelledMessage({
    rent_request_id: 'r1', agent_id: 'a1', agent_phone: '+256700000000',
    agent_name: 'TIMOTHY', landlord_name: 'John Kibalama', tenant_name: 'Aaron Gwokto',
    rent_amount: 100000, ref: '9C078BF7',
  });

  same('A4', actual, `The UGX 100,000 landlord float for John Kibalama was not paid out
within 24 hours and has been returned. Aaron Gwokto's Rent Plan has been
cancelled and can be submitted again. Ref 9C078BF7.`);
});

/* ------------------------------------------------------------------ *
 * To the tenant
 * ------------------------------------------------------------------ */

Deno.test('T1 matches the document', () => {
  const actual = tenantMessage({
    rent_request_id: 'r1', tenant_id: 't1', tenant_phone: '+256700000001',
    tenant_first_name: 'Aaron', landlord_name: 'John Kibalama',
    rent_amount: 100000, instalment: 4767, period_label: 'per day',
    duration_days: 30, total_repayment: 143000,
    repayment_starts_on: '2026-09-29', agent_name: 'TIMOTHY',
    agent_phone: '+256778315407', ref: '9C078BF7',
  });

  same('T1', actual, `Welcome to Welile, Aaron.

Your rent of UGX 100,000 has been paid to your landlord
John Kibalama.

Your repayment starts TOMORROW, Tuesday 29 September:
  UGX 4,767 per day
  for 30 days
  Total to repay: UGX 143,000

Your agent TIMOTHY (+256778315407) will collect from you.
Ref 9C078BF7.`);
});

Deno.test('T2 matches the document', () => {
  const actual = tenantCancelledMessage({
    rent_request_id: 'r1', tenant_id: 't1', tenant_phone: '+256700000001',
    tenant_first_name: 'Aaron', rent_amount: 100000,
    landlord_name: 'John Kibalama', ref: '9C078BF7',
  });

  same('T2', actual, `Aaron, the Rent Plan for your rent of UGX 100,000 could
not be completed because the landlord payment was not made in time. Nothing
is owed by you. Your agent can submit the request again. Ref 9C078BF7.`);
});

Deno.test('A2 matches the document', () => {
  const actual = agentNudgeMessage({
    rent_request_id: 'r1', agent_id: 'a1', agent_phone: '+256700000000',
    agent_name: 'TIMOTHY', landlord_name: 'John Kibalama', tenant_name: 'Aaron Gwokto',
    amount: 100000, severity: 'reminder', hours_left: 18,
    ref: '9C078BF7', deadline_time: '16:43', deadline_date: 'Tuesday 29 September',
  });

  same('A2', actual, `UGX 100,000 landlord float for John Kibalama (Aaron Gwokto) is still
in your wallet. Pay the landlord by 16:43 on Tuesday 29 September.
Payouts run 06:00–22:00. Ref 9C078BF7.`);
});

Deno.test('AP matches the document', () => {
  const actual = agentPaidMessage({
    rent_request_id: 'r1', agent_id: 'a1', agent_phone: '+256700000000',
    agent_name: 'PIUSLUBEGA SSENKALI', landlord_name: 'DEMO',
    tenant_first_name: 'SSEMANDO', rent_amount: 100000,
    instalment: 4767, period_label: 'per day',
    repayment_starts_on: '2026-09-30',
    receipt_number: 'WLR-100336', receipt_code: '5NKSV5RMGB', commission_ugx: 1000,
  });

  same('AP', actual, `UGX 100,000 has been paid to landlord DEMO. Receipt No: WLR-100336 (Code: 5NKSV5RMGB).

SSEMANDO starts repaying TOMORROW, Wednesday 30 September: UGX 4,767 per day.

You earned UGX 1,000 commission.

View receipt: https://welileapp.com/r/5NKSV5RMGB

Please upload the receipt.`);
});

// The conditional parts, also from the document: built WITHOUT them, not with
// an empty placeholder. This is the A1 mistake in miniature - a receipt that is
// not there must not leave 'Receipt No: .' or a dead link in a live SMS.
Deno.test('AP drops the receipt lines and the commission when neither exists', () => {
  const actual = agentPaidMessage({
    rent_request_id: 'r1', agent_id: 'a1', agent_phone: '+256700000000',
    agent_name: 'PIUSLUBEGA SSENKALI', landlord_name: 'DEMO',
    tenant_first_name: 'SSEMANDO', rent_amount: 100000,
    instalment: 4767, period_label: 'per day',
    repayment_starts_on: '2026-09-30',
    receipt_number: null, receipt_code: null, commission_ugx: null,
  });

  same('AP (no receipt, no commission)', actual, `UGX 100,000 has been paid to landlord DEMO.

SSEMANDO starts repaying TOMORROW, Wednesday 30 September: UGX 4,767 per day.

Please upload the receipt.`);
});

// The number and the code are one receipt. Quoting one without the other would
// give the agent something they cannot look up, so a half-present receipt is
// treated as no receipt at all.
Deno.test('AP does not quote a receipt number that has no code', () => {
  const actual = agentPaidMessage({
    rent_request_id: 'r1', agent_id: 'a1', agent_phone: '+256700000000',
    agent_name: 'PIUSLUBEGA SSENKALI', landlord_name: 'DEMO',
    tenant_first_name: 'SSEMANDO', rent_amount: 100000,
    instalment: 4767, period_label: 'per day',
    repayment_starts_on: '2026-09-30',
    receipt_number: 'WLR-100336', receipt_code: null, commission_ugx: null,
  });

  same('AP (number only)', actual, `UGX 100,000 has been paid to landlord DEMO.

SSEMANDO starts repaying TOMORROW, Wednesday 30 September: UGX 4,767 per day.

Please upload the receipt.`);
});

/* ------------------------------------------------------------------ *
 * AP by email - the data the template is rendered from
 * ------------------------------------------------------------------ */

const emailNotice = {
  rent_request_id: '2d6e0c1a-0000-4000-8000-000000000001',
  agent_id: 'a1', agent_email: 'agent@example.com',
  agent_name: 'PIUSLUBEGA SSENKALI', landlord_name: 'Don Adrew kagwa',
  tenant_name: 'Susan Sandra Namiilo', rent_amount: 800000,
  instalment: 36000, period_label: 'per day',
  repayment_starts_on: '2026-10-13',
  receipt_number: 'WLR-101212', receipt_code: '4N2X3GDHAE',
  paid_at: '2026-10-09T07:42:46.263+00:00',
  commission_ugx: 8000, ref: '2D6E0C1A',
};

Deno.test('AP email data quotes the same receipt the SMS does', () => {
  const d = agentPaidEmailData(emailNotice);
  assertEquals(d.receipt_number, 'WLR-101212');
  assertEquals(d.receipt_code, '4N2X3GDHAE');
  assertEquals(d.receipt_url, 'https://welileapp.com/r/4N2X3GDHAE');
  assertEquals(d.amount, 800000);
  assertEquals(d.agent_name, 'PIUSLUBEGA');
  assertEquals(d.commission, 8000);
});

// email_send_log is the only record that this plan has been emailed, and it
// stores the template data, so the plan id has to be in it.
Deno.test('AP email data carries the plan id used to de-duplicate', () => {
  assertEquals(agentPaidEmailData(emailNotice).rent_request_id, emailNotice.rent_request_id);
});

// 07:42 UTC is 10:42 in Kampala. Printing UTC here would tell the agent they
// were paid three hours before they were.
Deno.test('AP email shows the payout time in Kampala time', () => {
  assertEquals(agentPaidEmailData(emailNotice).paid_on, '09 Oct 2026, 10:42');
});

Deno.test('AP email data leaves the commission empty when none was posted', () => {
  assertEquals(agentPaidEmailData({ ...emailNotice, commission_ugx: null }).commission, '');
});
