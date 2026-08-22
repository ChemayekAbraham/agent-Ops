DROP TRIGGER IF EXISTS trg_promissory_commission_portfolio ON public.investor_portfolios;
DROP TRIGGER IF EXISTS trg_promissory_commission_self_commitment ON public.partner_self_commitments;
DROP TRIGGER IF EXISTS trg_promissory_commission_self_topup ON public.partner_self_topups;
DROP FUNCTION IF EXISTS public.credit_promissory_agent_commission(uuid, numeric, text, text, text);
DROP FUNCTION IF EXISTS public.try_credit_promissory_agent_commission(uuid, numeric, text, text, text);
DROP FUNCTION IF EXISTS public.smoke_promissory_commissions(uuid, uuid);

CREATE OR REPLACE FUNCTION public.credit_promissory_agent_commission(
  p_partner_id uuid,
  p_base_amount numeric,
  p_kind text,
  p_source_table text,
  p_source_id uuid,
  p_dedupe_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
DECLARE
  v_note_id uuid;
  v_agent_id uuid;
  v_rate numeric;
  v_amount numeric;
  v_idem text;
  v_group uuid;
  v_label text;
BEGIN
  IF p_partner_id IS NULL OR p_source_id IS NULL OR coalesce(p_base_amount,0) <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','no_base_amount');
  END IF;

  SELECT n.id, n.agent_id
    INTO v_note_id, v_agent_id
    FROM public.promissory_notes n
   WHERE n.partner_user_id = p_partner_id
     AND n.agent_id IS NOT NULL
     AND coalesce(n.approval_bonus_paid, false) = true
   ORDER BY n.approved_at DESC NULLS LAST, n.created_at DESC
   LIMIT 1;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','partner_not_promissory_linked');
  END IF;

  v_rate := public.promissory_commission_rate(p_kind, now());
  IF coalesce(v_rate,0) <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','no_rate_in_force');
  END IF;

  v_amount := round(p_base_amount * v_rate);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','amount_rounds_to_zero');
  END IF;

  IF p_kind = 'portfolio_creation' AND EXISTS (
    SELECT 1 FROM public.promissory_commission_events e
     WHERE e.note_id = v_note_id AND e.kind = 'portfolio_creation' AND e.status = 'paid'
  ) THEN
    RETURN jsonb_build_object('status','skipped','reason','creation_commission_already_paid');
  END IF;

  v_idem := 'promissory_commission:' || p_kind || ':' || p_source_table || ':'
            || coalesce(p_dedupe_key, p_source_id::text);

  IF EXISTS (SELECT 1 FROM public.promissory_commission_events e
              WHERE e.idempotency_key = v_idem AND e.status = 'paid') THEN
    RETURN jsonb_build_object('status','skipped','reason','duplicate_source');
  END IF;

  v_label := CASE WHEN p_kind = 'portfolio_creation'
                  THEN 'Promissory partner portfolio commission ('
                  ELSE 'Promissory partner top-up commission (' END
             || to_char(v_rate * 100, 'FM999.99') || '%)';

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object('user_id', v_agent_id, 'amount', v_amount,
        'direction','cash_out', 'category','marketing_expense',
        'source_table', p_source_table, 'source_id', p_source_id::text,
        'description', 'Marketing expense: ' || v_label,
        'ledger_scope','platform'),
      jsonb_build_object('user_id', v_agent_id, 'amount', v_amount,
        'direction','cash_in', 'category','agent_commission',
        'source_table', p_source_table, 'source_id', p_source_id::text,
        'description', v_label,
        'ledger_scope','wallet', 'recipient_type','user')),
    v_idem);

  INSERT INTO public.promissory_commission_events
    (note_id, agent_id, partner_id, kind, base_amount, rate, amount,
     source_table, source_id, idempotency_key, ledger_group_id, status)
  VALUES (v_note_id, v_agent_id, p_partner_id, p_kind, p_base_amount, v_rate, v_amount,
          p_source_table, p_source_id::text, v_idem, v_group, 'paid')
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('status','paid','amount',v_amount,'rate',v_rate,
                            'agent_id',v_agent_id,'note_id',v_note_id,'ledger_group_id',v_group);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_promissory_agent_commission(uuid, numeric, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.credit_promissory_agent_commission(uuid, numeric, text, text, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_promissory_agent_commission(uuid, numeric, text, text, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.try_credit_promissory_agent_commission(
  p_partner_id uuid, p_base_amount numeric, p_kind text,
  p_source_table text, p_source_id uuid, p_dedupe_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
BEGIN
  PERFORM public.credit_promissory_agent_commission(
    p_partner_id, p_base_amount, p_kind, p_source_table, p_source_id, p_dedupe_key);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.promissory_commission_events
    (partner_id, kind, base_amount, source_table, source_id,
     idempotency_key, status, error_message)
  VALUES (p_partner_id, p_kind, coalesce(p_base_amount,0), p_source_table, p_source_id::text,
          'promissory_commission:' || p_kind || ':' || p_source_table || ':'
            || coalesce(p_dedupe_key, coalesce(p_source_id::text,'null'))
            || ':failed:' || gen_random_uuid()::text,
          'failed', sqlerrm);
END;
$$;

REVOKE ALL ON FUNCTION public.try_credit_promissory_agent_commission(uuid, numeric, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.try_credit_promissory_agent_commission(uuid, numeric, text, text, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_credit_promissory_agent_commission(uuid, numeric, text, text, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_promissory_commission_portfolio()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
DECLARE v_delta numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'active' AND coalesce(NEW.investment_amount,0) > 0 THEN
      PERFORM public.try_credit_promissory_agent_commission(
        NEW.investor_id, NEW.investment_amount, 'portfolio_creation',
        'investor_portfolios', NEW.id, NEW.id::text);
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.status = 'active' AND coalesce(OLD.status,'') <> 'active'
     AND coalesce(NEW.investment_amount,0) > 0 THEN
    PERFORM public.try_credit_promissory_agent_commission(
      NEW.investor_id, NEW.investment_amount, 'portfolio_creation',
      'investor_portfolios', NEW.id, NEW.id::text);
    RETURN NULL;
  END IF;

  v_delta := coalesce(NEW.investment_amount,0) - coalesce(OLD.investment_amount,0);
  IF v_delta > 0 AND NEW.status = 'active' THEN
    PERFORM public.try_credit_promissory_agent_commission(
      NEW.investor_id, v_delta, 'portfolio_topup',
      'investor_portfolios', NEW.id,
      NEW.id::text || ':' || round(coalesce(NEW.investment_amount,0))::text);
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_promissory_commission_portfolio
  AFTER INSERT OR UPDATE OF status, investment_amount ON public.investor_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.trg_promissory_commission_portfolio();

CREATE OR REPLACE FUNCTION public.trg_promissory_commission_self_commitment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
BEGIN
  IF NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR coalesce(OLD.status,'') <> 'active')
     AND coalesce(NEW.committed_amount,0) > 0 THEN
    PERFORM public.try_credit_promissory_agent_commission(
      NEW.partner_id, NEW.committed_amount, 'portfolio_creation',
      'partner_self_commitments', NEW.id, NEW.id::text);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_promissory_commission_self_commitment
  AFTER INSERT OR UPDATE OF status ON public.partner_self_commitments
  FOR EACH ROW EXECUTE FUNCTION public.trg_promissory_commission_self_commitment();

CREATE OR REPLACE FUNCTION public.trg_promissory_commission_self_topup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
BEGIN
  IF NEW.status IN ('approved','active','applied')
     AND (TG_OP = 'INSERT' OR coalesce(OLD.status,'') IS DISTINCT FROM NEW.status)
     AND coalesce(NEW.amount,0) > 0 THEN
    PERFORM public.try_credit_promissory_agent_commission(
      NEW.partner_id, NEW.amount, 'portfolio_topup',
      'partner_self_topups', NEW.id, NEW.id::text);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_promissory_commission_self_topup
  AFTER INSERT OR UPDATE OF status ON public.partner_self_topups
  FOR EACH ROW EXECUTE FUNCTION public.trg_promissory_commission_self_topup();

REVOKE ALL ON FUNCTION public.trg_promissory_commission_portfolio() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_promissory_commission_portfolio() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_promissory_commission_self_commitment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_promissory_commission_self_commitment() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_promissory_commission_self_topup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_promissory_commission_self_topup() FROM anon, authenticated;

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
  v_src1 uuid := gen_random_uuid();
  v_src2 uuid := gen_random_uuid();
  v_src3 uuid := gen_random_uuid();
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
      p_partner_id, 1000000, 'portfolio_creation', 'investor_portfolios', v_src1);
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
      p_partner_id, 1000000, 'portfolio_creation', 'investor_portfolios', v_src1);
    v_report := v_report || jsonb_build_object(
      'stage','creation_idempotent','result',v_r,
      'pass', (v_r->>'status') = 'skipped' AND (v_r->>'reason') = 'duplicate_source');

    v_r := public.credit_promissory_agent_commission(
      p_partner_id, 500000, 'portfolio_creation', 'investor_portfolios', v_src2);
    v_report := v_report || jsonb_build_object(
      'stage','creation_once_per_note','result',v_r,
      'pass', (v_r->>'status') = 'skipped' AND (v_r->>'reason') = 'creation_commission_already_paid');

    v_r := public.credit_promissory_agent_commission(
      p_partner_id, 500000, 'portfolio_topup', 'investor_portfolios', v_src3);
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
      gen_random_uuid(), 1000000, 'portfolio_creation', 'investor_portfolios', gen_random_uuid());
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