CREATE OR REPLACE FUNCTION public.smoke_promissory_commissions_authorized()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
  SELECT auth.uid() IS NULL
      OR EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE ur.user_id = auth.uid()
                    AND ur.role = ANY (ARRAY['cfo','manager','super_admin','ceo','cto']::app_role[]))
$$;

REVOKE ALL ON FUNCTION public.smoke_promissory_commissions_authorized() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.smoke_promissory_commissions_authorized() FROM anon;
GRANT EXECUTE ON FUNCTION public.smoke_promissory_commissions_authorized() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.smoke_promissory_commissions(
  p_agent_id uuid, p_partner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
DECLARE
  v_report jsonb := '[]'::jsonb;
  v_note_id uuid := gen_random_uuid();
  v_src1 text := 'smoke:' || gen_random_uuid()::text;
  v_src2 text := 'smoke:' || gen_random_uuid()::text;
  v_src3 text := 'smoke:' || gen_random_uuid()::text;
  v_r jsonb;
  v_legs int;
  v_net numeric;
BEGIN
  IF NOT public.smoke_promissory_commissions_authorized() THEN
    RETURN jsonb_build_object('status','error','message','Not authorised');
  END IF;

  BEGIN
    v_report := v_report || jsonb_build_object(
      'stage','rates',
      'creation_rate', public.promissory_commission_rate('portfolio_creation'),
      'topup_rate', public.promissory_commission_rate('portfolio_topup'),
      'pass', public.promissory_commission_rate('portfolio_creation') = 0.02
          AND public.promissory_commission_rate('portfolio_topup') = 0.01);

    INSERT INTO public.promissory_notes
      (id, agent_id, partner_name, whatsapp_number, phone_number, amount,
       contribution_type, deduction_day, status, partner_user_id,
       approved_at, approval_bonus_paid, notes)
    VALUES (v_note_id, p_agent_id, 'SMOKE PARTNER', '+256700000000', '+256700000000',
            1000000, 'monthly', 1, 'activated', p_partner_id,
            now(), true, 'SMOKE TEST - rolled back');
    v_report := v_report || jsonb_build_object('stage','note_created','note_id',v_note_id,'pass',true);

    v_r := public.credit_promissory_agent_commission(
      p_partner_id, 1000000, 'portfolio_creation', 'smoke_portfolios', v_src1);
    v_report := v_report || jsonb_build_object(
      'stage','creation_2pct','result',v_r,
      'pass', (v_r->>'status') = 'paid' AND (v_r->>'amount')::numeric = 20000);

    SELECT count(*), coalesce(sum(CASE WHEN direction='cash_in' THEN amount ELSE -amount END),0)
      INTO v_legs, v_net
      FROM public.general_ledger
     WHERE transaction_group_id = (v_r->>'ledger_group_id')::uuid;
    v_report := v_report || jsonb_build_object(
      'stage','ledger_balanced','legs',v_legs,'net',v_net,
      'pass', v_legs = 2 AND v_net = 0);

    v_r := public.credit_promissory_agent_commission(
      p_partner_id, 1000000, 'portfolio_creation', 'smoke_portfolios', v_src1);
    v_report := v_report || jsonb_build_object(
      'stage','creation_idempotent','result',v_r,
      'pass', (v_r->>'status') = 'skipped' AND (v_r->>'reason') = 'duplicate_source');

    v_r := public.credit_promissory_agent_commission(
      p_partner_id, 500000, 'portfolio_creation', 'smoke_portfolios', v_src2);
    v_report := v_report || jsonb_build_object(
      'stage','creation_once_per_note','result',v_r,
      'pass', (v_r->>'status') = 'skipped' AND (v_r->>'reason') = 'creation_commission_already_paid');

    v_r := public.credit_promissory_agent_commission(
      p_partner_id, 500000, 'portfolio_topup', 'smoke_topups', v_src3);
    v_report := v_report || jsonb_build_object(
      'stage','topup_1pct','result',v_r,
      'pass', (v_r->>'status') = 'paid' AND (v_r->>'amount')::numeric = 5000);

    v_report := v_report || jsonb_build_object(
      'stage','audit_trail',
      'rows', (SELECT count(*) FROM public.promissory_commission_events WHERE note_id = v_note_id),
      'total_paid', (SELECT coalesce(sum(amount),0) FROM public.promissory_commission_events
                      WHERE note_id = v_note_id AND status = 'paid'),
      'pass', (SELECT coalesce(sum(amount),0) FROM public.promissory_commission_events
                WHERE note_id = v_note_id AND status = 'paid') = 25000);

    v_r := public.credit_promissory_agent_commission(
      gen_random_uuid(), 1000000, 'portfolio_creation', 'smoke_portfolios',
      'smoke:' || gen_random_uuid()::text);
    v_report := v_report || jsonb_build_object(
      'stage','non_promissory_partner_skipped','result',v_r,
      'pass', (v_r->>'status') = 'skipped' AND (v_r->>'reason') = 'partner_not_promissory_linked');

    RAISE EXCEPTION 'SMOKE_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF sqlerrm <> 'SMOKE_ROLLBACK' THEN
      v_report := v_report || jsonb_build_object('stage','fatal','error',sqlerrm,'pass',false);
    END IF;
  END;

  RETURN jsonb_build_object(
    'rolled_back', true,
    'all_passed', (SELECT bool_and(coalesce((x->>'pass')::boolean,false))
                     FROM jsonb_array_elements(v_report) x),
    'stages', v_report);
END;
$$;

REVOKE ALL ON FUNCTION public.smoke_promissory_commissions(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.smoke_promissory_commissions(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.smoke_promissory_commissions(uuid, uuid) TO authenticated, service_role;