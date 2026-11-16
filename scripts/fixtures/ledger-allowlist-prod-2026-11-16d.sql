-- Verbatim production copy (16 Nov 2026 after items 1-5, read-only export).
CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT ((((public.ledger_category_allowlist_base() || ARRAY[

    'staff_loan_charge_collected',

    'agent_advance_receivable_opening',

    'agent_access_fee_receivable_opening',

    'merchandise_recovery_receivable_opening',

    'bike_recovery_receivable_opening',

    'credit_draw_receivable_opening',

    'merchandise_credit_sale_receivable_opening',

    'service_centre_advance_receivable_opening',

    'service_centre_receivable_opening',

    'tenant_service_charge_receivable_opening',

    'business_advance_receivable_opening',

    'rent_plan_receivable_restatement',

    'receivable_restatement_equity',

    'merchandise_recovery_repayment',

    'bike_recovery_repayment',

    'credit_draw_repayment',

    'smartphone_advance_receivable',

    'agent_advance_disbursement',

    'agent_advance_access_fee_charged',

    'agent_advance_registration_fee_charged',

    'agent_advance_fee_revenue',

    'agent_advance_penalty_accrued',

    'agent_advance_penalty_unearned',

    'agent_advance_access_fee_collected',

    'agent_advance_registration_fee_collected',

    'agent_advance_written_off',

    'agent_advance_access_fee_written_off',

    'agent_advance_registration_fee_written_off',

    'agent_advance_reversed',

    'agent_advance_clawback',

    'agent_advance_late_fee_income',

    'agent_advance_access_fee_collected_external',

    'agent_advance_registration_fee_collected_external',

    'agent_advance_penalty_accrued_external',

    -- Landlord Float Pool (20260929160000, 20260929180000, 20260929240000)

    'landlord_pool_reserve_self_support',

    'landlord_pool_reserve_company_managed',

    'landlord_pool_reserve_source',

    'landlord_pool_topup_self_support',

    'landlord_pool_topup_company_managed',

    'landlord_pool_compound_self_support',

    'landlord_pool_compound_company_managed',

    'landlord_pool_deploy_self_support',

    'landlord_pool_deploy_company_managed',

    'landlord_pool_deploy_target',

    'landlord_pool_return_self_support',

    'landlord_pool_return_company_managed',

    'landlord_pool_return_source',

    'landlord_pool_release_self_support',

    'landlord_pool_release_company_managed',

    'landlord_pool_release_target'

  ]::text[]) || ARRAY['special_advance_credit', 'special_advance_receivable', 'special_advance_payout_cash',

                       'special_advance_fee_revenue', 'special_advance_repayment_received', 'special_advance_repayment']::text[]) || ARRAY['special_advance_impairment_charge', 'special_advance_impairment_allowance', 'special_advance_write_off',

                       'special_advance_write_off_loss', 'special_advance_recovery_received', 'special_advance_recovery_income']::text[]

    -- 2026-11-04 (CFO, merchandise phase 3): merchandise sales revenue (R1); offset of the advance shown on an agent's

    -- wallet for a phone bought by the company (L1 memo, not money owed to the agent)

    || ARRAY['merchandise_revenue', 'merchandise_advance_memo_offset', 'merchandise_payment_retained']::text[]

    || ARRAY['agent_advance_memo_offset']::text[]

    -- 2026-11-10 (CFO draft): platform-only reversal of a float restatement loss booked in error (X6)

    || ARRAY['float_restatement_correction']::text[]) || ARRAY['welile_cover_fee']::text[]

    -- 2026-11-11 (CFO): salary advances to employees (A27 Loans and Advances to Employees)

    || ARRAY['salary_advance_disbursed', 'salary_advance_cash_paid', 'salary_advance_recovered', 'salary_advance_recovery_expense']::text[]
    -- 2026-11-12 (CFO): Welile Homes landlord float paid to landlords settles the landlord payout obligation (L4)
    || ARRAY['wh_landlord_float_settled']::text[]
    -- 2026-11-12 (CFO): Special Advance repaid from the borrower's wallet (wallet L1 / platform A24)
    || ARRAY['special_advance_wallet_repayment']::text[]
    -- 2026-11-12 (Joshua, CTO): mobile-money and bank-transfer advance repayments
    || ARRAY['agent_advance_receipt_bank', 'agent_advance_repayment_external']::text[]) || ARRAY['partner_direct_rent_capital']::text[]
    -- 2026-11-16 (CFO): landlord rent payout sent — settles the rent owed to the landlord (L4) and is the cash leaving (A1)
    || ARRAY['landlord_rent_payout_settled', 'landlord_rent_payout_cash']::text[]
    -- 2026-11-16 (CFO): reclassification of a wallet correction to the account of the credit it reversed
    || ARRAY['wallet_correction_reclass_e3', 'wallet_correction_reclass_x1', 'wallet_correction_reclass_x2', 'wallet_correction_reclass_x3', 'wallet_correction_reclass_x4', 'wallet_correction_reclass_a1', 'wallet_correction_reclass_a2', 'wallet_correction_reclass_a8', 'wallet_correction_reclass_a10', 'wallet_correction_reclass_l6']::text[];
$function$;
