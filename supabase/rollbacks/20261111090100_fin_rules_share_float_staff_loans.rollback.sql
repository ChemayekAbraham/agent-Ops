-- Rollback for 20261111090100_fin_rules_share_float_staff_loans.sql.
-- Restores the production definitions read on 11 Nov 2026 and removes the new rows. Any staff_loan_charge_collected
-- legs posted while the rule was live would fall back to suspense after rollback: check before rolling back.
DELETE FROM public.fin_cash_flow_map WHERE account_code IN ('A26','A27','R4') AND category IS NULL;
DELETE FROM public.fin_pnl_lines WHERE account_code = 'R4' AND category IS NULL;
DELETE FROM public.ledger_account_map
 WHERE (ledger_scope = 'wallet' AND category = 'share_capital' AND wallet_bucket = 'float')
    OR (ledger_scope = 'platform' AND category IN ('staff_loan_disbursement','staff_loan_repayment','staff_loan_charge_collected') AND wallet_bucket IS NULL);
DELETE FROM public.ledger_account_catalog WHERE code IN ('A26','A27','R4');

CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT ((public.ledger_category_allowlist_base() || ARRAY[
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
    || ARRAY['agent_advance_memo_offset']::text[];
$function$;

CREATE OR REPLACE FUNCTION public.staff_loan_recover_from_wallet(p_user_id uuid, p_max_amount numeric DEFAULT NULL::numeric, p_source text DEFAULT 'wallet_recovery'::text)
 RETURNS TABLE(loan_id uuid, recovered numeric, closed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r           record;
  ins         record;
  v_available numeric;
  v_due       numeric;
  v_take      numeric;
  v_left      numeric;
  v_alloc     numeric;
  v_interest  numeric;
  v_principal numeric;
  v_idem      text;
  v_open      integer;
begin
  for r in
    select l.* from public.staff_loans l
    where l.user_id = p_user_id
      and l.status = 'active'
      and exists (
        select 1 from public.staff_loan_instalments si
        where si.loan_id = l.id and si.status <> 'paid' and si.due_on <= current_date
      )
    order by l.started_on
  loop
    select coalesce(sum(si.amount_due - si.amount_paid), 0) into v_due
      from public.staff_loan_instalments si
     where si.loan_id = r.id and si.status <> 'paid' and si.due_on <= current_date;

    v_available := greatest(0, coalesce(public.get_user_available_balance(p_user_id), 0));
    if p_max_amount is not null then
      v_available := least(v_available, greatest(0, p_max_amount));
    end if;

    v_take := floor(least(v_available, v_due));
    if v_take <= 0 then continue; end if;

    v_left := v_take;
    for ins in
      select * from public.staff_loan_instalments
       where loan_id = r.id and status <> 'paid' and due_on <= current_date
       order by seq
    loop
      exit when v_left <= 0;
      v_alloc := least(v_left, ins.amount_due - ins.amount_paid);
      update public.staff_loan_instalments
         set amount_paid = amount_paid + v_alloc,
             status = case when ins.amount_paid + v_alloc >= ins.amount_due
                           then 'paid' else 'partial' end
       where id = ins.id;
      v_left := v_left - v_alloc;
    end loop;

    v_interest  := least(v_take, r.accrued_interest);
    v_principal := v_take - v_interest;
    v_idem      := 'staff_loan_recovery_' || r.id::text || '_' || to_char(current_date,'YYYYMMDD');

    perform public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', p_user_id, 'ledger_scope', 'wallet', 'direction', 'cash_out',
          'amount', v_take, 'category', 'staff_loan_repayment', 'recipient_type', 'user',
          'source_table', 'staff_loans', 'source_id', r.id,
          'description', 'Staff loan instalment', 'currency', 'UGX',
          'transaction_date', current_date,
          'metadata', jsonb_build_object('source','staff_loan_recovery','loan_id', r.id,
                                         'interest_component', v_interest,
                                         'principal_component', v_principal)
        ),
        jsonb_build_object(
          'user_id', p_user_id, 'ledger_scope', 'platform', 'direction', 'cash_in',
          'amount', v_take, 'category', 'staff_loan_repayment', 'recipient_type', 'operational_wallet',
          'source_table', 'staff_loans', 'source_id', r.id,
          'description', 'Staff loan instalment received', 'currency', 'UGX',
          'transaction_date', current_date,
          'metadata', jsonb_build_object('source','staff_loan_recovery','loan_id', r.id)
        )
      ),
      idempotency_key := v_idem
    );

    insert into public.staff_loan_repayments
      (loan_id, user_id, amount, interest_component, principal_component, source)
    values
      (r.id, p_user_id, v_take, v_interest, v_principal, coalesce(p_source,'wallet_recovery'));

    select count(*) into v_open
      from public.staff_loan_instalments
     where loan_id = r.id and status <> 'paid';

    update public.staff_loans
       set accrued_interest      = greatest(0, accrued_interest - v_interest),
           outstanding_principal = greatest(0, outstanding_principal - v_principal),
           total_repaid          = total_repaid + v_take,
           status       = case when v_open = 0 then 'completed' else status end,
           completed_at = case when v_open = 0 then now() else completed_at end,
           updated_at   = now()
     where id = r.id;

    return query select r.id, v_take, (v_open = 0);
  end loop;
end;
$function$;
