# Welile Homes Live Database Investigation & Excel Export Prompt

> **Purpose**: Use this prompt when instructing an AI agent, database assistant, or technical engineer to perform a 100% read-only audit of Welile Homes transactions and export every individual record to an Excel spreadsheet without modifying any code or data.

---

```markdown
# TASK: Read-Only Welile Homes Database Audit & Excel Export

### ⚠️ CRITICAL OPERATING DIRECTIVES:
1. **STRICTLY READ-ONLY**: Do NOT write, modify, or delete any code, schemas, migrations, or application files.
2. **ZERO DATA MODIFICATIONS**: Do NOT execute any `INSERT`, `UPDATE`, `DELETE`, or ledger-altering operations. This is an investigation and reporting task only.
3. **INDIVIDUAL-LEVEL GRANULARITY**: Do NOT provide only summary aggregates or totals. Every individual tenant, agent, landlord, transaction, and due line-item must be detailed with full names and phone numbers.
4. **REGULATORY TERMINOLOGY**: Maintain approved platform terminology ("Rent Plan", "Supporter", "Returns").

---

### Database Investigation Requirements:

Please inspect the live database and extract all records related to **Welile Homes**, joining with `public.profiles` to resolve all user identities:

1. **Subscriptions Portfolio**:
   - Query `public.welile_homes_subscriptions` for all rows.
   - Categorize by `subscription_status` (Active vs. Cancelled / Declined).
   - Columns required:
     - Tenant Full Name & Phone Number (`profiles.full_name`, `profiles.phone`)
     - Tenant Verification Status (`profiles.verified`)
     - Assigned Field Agent Name & Phone Number
     - Property Owner / Landlord Name & Phone Number
     - Monthly Rent (UGX)
     - Booked Advance Receivable Total (UGX)
     - Outstanding Balance (UGX)
     - Payout Day
     - Smartphone Access (`has_smartphone`)
     - Subscription ID & Enrollment Date (`created_at`)

2. **Rent Collections & Repayments**:
   - Query `public.welile_homes_monthly_dues` where `amount_collected > 0` or `collection_status = 'collected'`.
   - Columns required:
     - Collection Date & Applied Period Month (`period_month`)
     - Tenant Full Name & Phone
     - Field Agent Full Name & Phone
     - Landlord Full Name & Phone
     - Amount Collected (UGX)
     - Landlord Share (90% Net)
     - Welile Platform Fee (8% Net)
     - Agent Commission Earned (2%)
     - Current Payout Status (`unpaid`, `paid`, or `paid_float`)

3. **Landlord Payouts Audit**:
   - Classify all payout obligations into:
     - **Settled Payouts**: Dues where `payout_status IN ('paid', 'paid_float')` with settlement date and disbursing float channel.
     - **Pending Payouts (Action Due)**: Dues where `collection_status = 'collected'` AND `payout_status = 'unpaid'`.
   - List beneficiary landlord name, phone, managing agent, amount, and payment channel.

4. **Agent Float Requests**:
   - Query `public.float_requests` for any requests where `reason ILIKE '%welile%'` or `product = 'welile_homes'`.
   - Columns required:
     - Request ID & Created Date
     - Requesting Agent Name & Phone Number
     - Requested Float Amount (UGX)
     - Status (`pending`, `approved`, `rejected`)
     - Recipient Phone Number
     - Operations Remarks / Reason & Rejection Reason (if rejected)

5. **General Ledger Reconciliation**:
   - Query `public.general_ledger` where `source_table IN ('welile_homes_subscriptions', 'welile_homes_monthly_dues')` or `description ILIKE '%welile home%'`.
   - List every individual transaction leg:
     - Transaction ID & Timestamp
     - Direction (`cash_in` vs. `cash_out`)
     - Accounting Category (`rent_repayment`, `rent_payment_for_tenant`, `agent_commission_earned`, `rent_disbursement`)
     - Scope (`platform` vs. `wallet`)
     - Amount (UGX)
     - Primary User Name & Phone Number
     - Linked Party Name & Phone Number
     - Ledger Description

6. **Involved People Directory**:
   - Distinct union of all `tenant_id`, `agent_id`, and `landlord_id` foreign keys resolved against `public.profiles`.
   - Full Name, Phone Number, Verification Status, and Account ID.

---

### Output Delivery:
- Generate a cleanly structured multi-tab Excel file (`.xlsx`) containing separate tabs for:
  1. `Executive Summary`
  2. `Subscriptions Portfolio`
  3. `Rent Collections`
  4. `Landlord Payouts`
  5. `Float Requests`
  6. `All Monthly Dues`
  7. `General Ledger`
  8. `Involved People`
- Save the file and provide the exact local/download file path.
```
