# A3 Rent Access Receivable — verification findings and proposed accounting-only correction

Read-only investigation complete. Nothing was posted, reversed, deleted or migrated.

## Is the intended behaviour in place?

| Required rule | Status |
| --- | --- |
| Funding a Rent Plan increases A3 | Correct — 1,347 increases of UGX 791,467,727 from rent plan records, plus UGX 50,773,021 of fee receivables |
| A valid tenant repayment decreases A3 | Correct — repayments net UGX 119,322,660 off A3 (they post as collections paired with agent cash, and the statement treats them as reductions) |
| A tenant payment must never create a new A3 receivable | Correct **going forward**; the collection routine no longer raises a receivable. The last such posting was 8 Sep 2026. A historical block remains |

Current A3 balance: **UGX 590,012,259**.

## The historical defect

Between 9 May and 8 Sep 2026, every tenant payment collected by an agent also raised a
*new* receivable, in addition to reducing the tenant's balance. Each carried the
description "Tenant rent allocation settled for landlord …".

- Erroneous increases raised: **10,794 postings, UGX 274,680,914**, across 1,104 Rent Plans
- Reversed by the 21 Sep 2026 correction: **9,606 postings, UGX 253,166,816** (1,039 plans)
- **Still unsupported today: 1,188 postings, UGX 21,514,098, across 370 Rent Plans**
- No reversal was over-applied and no reversal points at a posting that does not exist; 734 plans are fully cleared

Monthly profile of the erroneous increases: May UGX 23,854,511 · Jun 57,942,810 ·
Jul 105,443,564 · Aug 70,286,164 · Sep 17,153,865.

Largest remaining balances (Rent Plan · tenant · unsupported amount):

- Ikwaput Fatumah — UGX 903,100 (plan completed and fully repaid)
- Nyakaawa Dianah Jael — UGX 554,000 (completed, fully repaid)
- Naluwugge Margaret — UGX 497,000 (completed, fully repaid)
- Hadijah Nakajako — UGX 390,000 (completed, fully repaid)
- MBABAZZI BABIRYE JuliET — UGX 371,500 (still repaying)
- MANS DOES — UGX 350,000 · Lumu Bossa — UGX 317,000 · Nambirige Aisha — UGX 282,603 ·
  wambuzi Andrew — UGX 270,000 · Namukwaya Resty — UGX 262,400 (and 360 smaller plans)

The full 1,188-posting list is derivable exactly from the ledger and will be exported
before any correction is applied.

## Proposed correction (accounting only, nothing yet done)

1. Export the exact 1,188 remaining postings (posting reference, Rent Plan, tenant,
   date, amount) as the evidence file for approval.
2. Post one reversing entry per remaining posting, using the identical pattern as the
   21 Sep correction — same account, same amount, opposite direction, each naming the
   posting it reverses, so every entry is traceable one-to-one and cannot double-apply.
3. Expected effect: A3 falls by **UGX 21,514,098**, from UGX 590,012,259 to
   **UGX 568,498,161**. Nothing else moves.
4. Re-verify afterwards: zero unsupported receivable postings sourced from collections,
   no reversal exceeding its original, and A3 equal to the figure above.

Explicitly untouched by the proposal: wallet balances, tenant amounts owed or repaid,
commission, agent float, collection records, and every operational routine. The
correction only removes receivable entries that should never have been raised.

## Guardrail to keep it from returning

The collection routine no longer raises a receivable, so the defect cannot recur from
that path. As part of the same change I will add a standing check that flags any future
receivable entry sourced from a tenant collection, so a regression is visible
immediately rather than months later.

## Technical detail

- Affected legs: `general_ledger` where `category = 'rent_receivable_created'`,
  `ledger_scope = 'bridge'`, `source_table = 'agent_collections'`, `direction = 'cash_in'`,
  with no matching `A3 correction (1x reversal): … leg <id>` cash_out leg.
- `source_id` on those legs is the `rent_requests.id`, not an `agent_collections.id`.
- A3 mapping (`ledger_account_map`): increases via bridge `rent_receivable_created` and
  `fee_receivable_created`; decreases via platform `tenant_repayment`, `rent_repayment`,
  `rent_principal_collected`, and `tenant_repayment_collected` (sign-flipped by
  `sofp_ledger_legs` when the group carries an A2 agent-float leg).
- `agent_allocate_tenant_payment_internal` contains no `rent_receivable_created` posting
  today (verified against the live function body); the description string it still uses
  is attached to a different leg.
- Correction legs would be `classification = 'admin_correction'`, one per original leg,
  idempotent by the reversed-leg id embedded in the description.
