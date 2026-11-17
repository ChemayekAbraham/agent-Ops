-- Item 7 (CFO decisions 16 Nov 2026) — revenue recognition. ACCOUNTING ONLY: platform legs, no money movement, no
-- change to how Rent Plans, fees, collections or Returns work.
--   7a. Older Rent Plans (funded before the fee entries began on 8 Sep 2026; their fees went into Legacy Opening
--       Balance Adjustments E3 at the 22 Sep 2026 restatement): fees collected become revenue (R1), fees still unpaid
--       become deferred fees (L7) and are released by a nightly job as tenants repay. History: batch
--       acct_corr_202611_legacy_fees (docs/finance/corrections/2026-11-16_legacy_plan_fees.sql), run right after this.
--   7b. The partners' share of collected fees reduces Supporter Returns (X2) instead of sitting in deferred fees (L7).
--   7c. Deferred fees stay recognised on collection (no change).
-- Preflight pins production's category allowlist and the partner-share mapping of 16 Nov 2026.
-- Rollback: supabase/rollbacks/20261125130000_rent_plan_fee_revenue.rollback.sql

DO $pre$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.ledger_category_allowlist()'::regprocedure)) <> 'f0dff73756592455497250f0a1337c19' THEN
    RAISE EXCEPTION 'precondition failed: category allowlist is no longer production''s definition of 16 Nov 2026; re-derive this migration';
  END IF;
  IF (SELECT count(*) FROM public.ledger_account_map WHERE ledger_scope = 'platform' AND category = 'partner_returns_allocated'
        AND wallet_bucket IS NULL AND account_code = 'L7' AND debit_when = 'cash_out') <> 1
  OR (SELECT count(*) FROM public.ledger_account_map WHERE category = 'partner_returns_allocated') <> 1 THEN
    RAISE EXCEPTION 'precondition failed: the partner-share mapping is not the single platform L7 row';
  END IF;
  IF to_regclass('public.legacy_plan_fee_schedule') IS NOT NULL
  OR EXISTS (SELECT 1 FROM public.ledger_account_map WHERE category LIKE 'legacy_plan_fee_%') THEN
    RAISE EXCEPTION 'precondition failed: already installed';
  END IF;
END $pre$;

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
    || ARRAY['wallet_correction_reclass_e3', 'wallet_correction_reclass_x1', 'wallet_correction_reclass_x2', 'wallet_correction_reclass_x3', 'wallet_correction_reclass_x4', 'wallet_correction_reclass_a1', 'wallet_correction_reclass_a2', 'wallet_correction_reclass_a8', 'wallet_correction_reclass_a10', 'wallet_correction_reclass_l6']::text[]
    -- 2026-11-16 (CFO, item 7): fees of Rent Plans funded before the fee entries began (8 Sep 2026)
    || ARRAY['legacy_plan_fee_restated_e3', 'legacy_plan_fee_deferred', 'legacy_plan_fee_revenue']::text[];
$function$;


-- 7b. The partners' share of a collected Rent Plan fee reduces Supporter Returns (X2) instead of sitting in deferred
--     fees (L7): Supporters' Returns are already paid as an expense. Goes forward and re-states history.
UPDATE public.ledger_account_map
   SET account_code = 'X2', updated_at = now(),
       notes = COALESCE(notes || ' | ', '') || '2026-11-16 (CFO): partners'' share of collected fees reduces Supporter Returns (was L7).'
 WHERE ledger_scope = 'platform' AND category = 'partner_returns_allocated' AND wallet_bucket IS NULL AND account_code = 'L7';

-- 7a. Fees of Rent Plans funded before 8 Sep 2026 (no fee entries; the 22 Sep 2026 restatement put them in E3).
--     cash_in = debit for each row below.
INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes) VALUES
  ('platform', 'legacy_plan_fee_restated_e3', NULL, 'E3', 'cash_in', '2026-11-16 (CFO): older Rent Plan fee taken out of the 22 Sep 2026 restatement (E3).'),
  ('platform', 'legacy_plan_fee_deferred',    NULL, 'L7', 'cash_in', '2026-11-16 (CFO): older Rent Plan fee not yet collected (deferred, L7).'),
  ('platform', 'legacy_plan_fee_revenue',     NULL, 'R1', 'cash_in', '2026-11-16 (CFO): older Rent Plan fee collected (revenue, R1).');
INSERT INTO public.fin_pnl_lines (account_code, category, section, line_label, sort)
VALUES ('R1', 'legacy_plan_fee_revenue', 'revenue', 'Rent Plan access fees', 110);

-- The older Rent Plans in scope, their fee and the part recognisable while the Plan was open (written by the batch).
CREATE TABLE public.legacy_plan_fee_schedule (
  rent_request_id uuid PRIMARY KEY,
  fee             numeric NOT NULL CHECK (fee > 0),
  total_repayment numeric NOT NULL CHECK (total_repayment > 0),
  effective_fee   numeric NOT NULL CHECK (effective_fee >= 0 AND effective_fee <= fee),
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.legacy_plan_fee_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY legacy_plan_fee_schedule_finance_read ON public.legacy_plan_fee_schedule
  FOR SELECT TO authenticated USING ((SELECT public.has_role((SELECT auth.uid()), 'cfo'::public.app_role)));
CREATE POLICY mfa_required_for_staff ON public.legacy_plan_fee_schedule AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));
REVOKE ALL ON TABLE public.legacy_plan_fee_schedule FROM anon, authenticated;
GRANT SELECT ON TABLE public.legacy_plan_fee_schedule TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.legacy_plan_fee_schedule TO service_role;

-- Forward: as tenants keep repaying these older Plans, release the fee share of what they paid from deferred fees to
-- revenue (DR L7 / CR R1). Same formula as the history batch: fee collected = amount repaid x fee / total repayable,
-- capped at the recognisable fee. Platform legs only; nothing about the Plan or any wallet changes.
CREATE OR REPLACE FUNCTION public.recognise_legacy_plan_fees(p_as_at timestamptz DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_n int := 0; v_total numeric := 0; v_due numeric; v_done numeric; v_delta numeric;
BEGIN
  FOR r IN
    SELECT s.*, rr.amount_repaid
      FROM public.legacy_plan_fee_schedule s JOIN public.rent_requests rr ON rr.id = s.rent_request_id
     ORDER BY s.rent_request_id
  LOOP
    v_due := LEAST(r.effective_fee, ROUND(COALESCE(r.amount_repaid, 0) * r.fee / r.total_repayment));
    SELECT COALESCE(SUM(CASE WHEN g.direction = 'cash_out' THEN g.amount ELSE -g.amount END), 0) INTO v_done
      FROM public.general_ledger g
     WHERE g.category = 'legacy_plan_fee_revenue' AND g.source_id = r.rent_request_id;
    v_delta := v_due - v_done;
    IF v_delta >= 1 THEN
      PERFORM public.create_ledger_transaction(jsonb_build_array(
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', v_delta, 'category', 'legacy_plan_fee_deferred',
          'source_table', 'rent_requests', 'source_id', r.rent_request_id, 'currency', 'UGX', 'transaction_date', p_as_at,
          'description', format('Older Rent Plan fee collected (UGX %s): released from deferred fees', v_delta)),
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', v_delta, 'category', 'legacy_plan_fee_revenue',
          'source_table', 'rent_requests', 'source_id', r.rent_request_id, 'currency', 'UGX', 'transaction_date', p_as_at,
          'description', format('Rent Plan access fee earned on repayments of an older Rent Plan (UGX %s)', v_delta))),
        'legacy_plan_fee:' || r.rent_request_id::text || ':' || v_due::text, false);
      v_n := v_n + 1; v_total := v_total + v_delta;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('plans', v_n, 'amount', v_total, 'as_at', p_as_at);
END $function$;
REVOKE ALL ON FUNCTION public.recognise_legacy_plan_fees(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recognise_legacy_plan_fees(timestamptz) TO service_role;

-- nightly, before the 23:30 tie-out (Kampala time)
SELECT cron.schedule('recognise-legacy-plan-fees-nightly', '15 20 * * *', 'SELECT public.recognise_legacy_plan_fees(now());');
