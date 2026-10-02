-- FUNDIN-P2C v2. Approved: Bwayo (HR Lead), 2 Oct 2026, on executive authority.
-- Switches commission to the fund-in gate: full amount deployed, 2% first fund-in, 1% every later one,
-- one commission per fund-in, to one earner. Renewals and unlocks are not new money. Reconcile runs hourly.
DO $pre$
BEGIN
  IF to_regprocedure('public.commission_pay_fund_in(uuid)') IS NULL
     OR to_regprocedure('public.commission_reconcile_fund_ins(integer)') IS NULL
     OR to_regprocedure('public.commission_enqueue_candidate(uuid,uuid,text,text,text,numeric)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAIL: FUNDIN-P2A or P2B not applied';
  END IF;
END $pre$;

INSERT INTO public.commission_gate_settings (id, cutover_at, note)
VALUES (true, now(), 'Fund-in gate live. Before this instant: settled by recompute. After: paid by the gate.')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.trg_promissory_commission_portfolio()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
DECLARE v_delta numeric;
BEGIN
  IF public.hr_pay_is_staff_reinvest_portfolio(NEW.id) THEN RETURN NULL; END IF;
  IF NEW.status = 'active' AND coalesce(NEW.investment_amount,0) > 0
     AND (TG_OP = 'INSERT'
          OR coalesce(OLD.status,'') IN ('pending_ops_approval','awaiting_partner_details','pending','pending_approval','draft')) THEN
    PERFORM public.commission_enqueue_candidate(NEW.investor_id, NEW.id, 'investor_portfolios',
      NEW.id::text, 'portfolio_activation', NEW.investment_amount);
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'active' THEN
    v_delta := coalesce(NEW.investment_amount,0) - coalesce(OLD.investment_amount,0);
    IF v_delta > 0 THEN
      PERFORM public.commission_enqueue_candidate(NEW.investor_id, NEW.id, 'investor_portfolios',
        NEW.id::text || ':' || round(coalesce(NEW.investment_amount,0))::text, 'principal_increase', v_delta);
    END IF;
  END IF;
  RETURN NULL;
END $f$;

CREATE OR REPLACE FUNCTION public.trg_credit_promissory_portfolio_topup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
DECLARE v_partner uuid;
BEGIN
  IF NEW.source_table = 'investor_portfolios' AND NEW.source_id IS NOT NULL
     AND public.hr_pay_is_staff_reinvest_portfolio(NEW.source_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.operation_type = 'portfolio_topup' AND NEW.status = 'completed' AND coalesce(NEW.amount,0) > 0
     AND (TG_OP = 'INSERT' OR coalesce(OLD.status,'') IS DISTINCT FROM 'completed') THEN
    SELECT ip.investor_id INTO v_partner
      FROM public.investor_portfolios ip
     WHERE NEW.source_table = 'investor_portfolios' AND ip.id = NEW.source_id;
    PERFORM public.commission_enqueue_candidate(coalesce(v_partner, NEW.user_id),
      CASE WHEN NEW.source_table = 'investor_portfolios' THEN NEW.source_id END,
      'pending_wallet_operations', NEW.id::text, 'topup_completed', NEW.amount);
  END IF;
  RETURN NEW;
END $f$;

CREATE OR REPLACE FUNCTION public.trg_promissory_commission_self_commitment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
BEGIN
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR coalesce(OLD.status,'') <> 'active')
     AND coalesce(NEW.committed_amount,0) > 0 THEN
    PERFORM public.commission_enqueue_candidate(NEW.partner_id, NULL, 'partner_self_commitments',
      NEW.id::text, 'self_commitment', NEW.committed_amount);
  END IF;
  RETURN NULL;
END $f$;

CREATE OR REPLACE FUNCTION public.trg_promissory_commission_self_topup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
BEGIN
  IF NEW.status IN ('approved','active','applied')
     AND (TG_OP = 'INSERT' OR coalesce(OLD.status,'') IS DISTINCT FROM NEW.status)
     AND coalesce(NEW.amount,0) > 0 THEN
    PERFORM public.commission_enqueue_candidate(NEW.partner_id, NULL, 'partner_self_topups',
      NEW.id::text, 'self_topup', NEW.amount);
  END IF;
  RETURN NULL;
END $f$;

DROP TRIGGER IF EXISTS trg_proxy_agent_portfolio_commission ON public.investor_portfolios;
DROP TRIGGER IF EXISTS trg_proxy_agent_portfolio_topup_commission ON public.pending_wallet_operations;

CREATE OR REPLACE FUNCTION public.credit_promissory_agent_commission(
  p_partner_id uuid, p_base_amount numeric, p_kind text, p_source_table text, p_source_id uuid, p_dedupe_key text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
BEGIN
  RETURN jsonb_build_object('status','skipped','reason','superseded_by_fund_in_gate');
END $f$;

CREATE OR REPLACE FUNCTION public.credit_proxy_agent_portfolio_commission(
  p_partner_id uuid, p_base_amount numeric, p_kind text, p_source_table text, p_source_id uuid, p_dedupe_key text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
BEGIN
  RETURN jsonb_build_object('status','skipped','reason','superseded_by_fund_in_gate');
END $f$;

CREATE OR REPLACE FUNCTION public.pay_proxy_commission_queue_item(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
BEGIN
  RETURN jsonb_build_object('status','skipped','reason','superseded_by_fund_in_gate');
END $f$;

CREATE OR REPLACE FUNCTION public.promissory_catch_up_partner_commission(p_partner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
DECLARE r record; v_n int := 0;
BEGIN
  IF p_partner_id IS NULL THEN RETURN jsonb_build_object('status','skipped','reason','no_partner'); END IF;
  FOR r IN SELECT id FROM public.commission_fund_ins
            WHERE partner_id = p_partner_id AND status = 'unattributed' ORDER BY occurred_at LOOP
    PERFORM public.commission_pay_fund_in(r.id);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('status','ok','sources_considered', v_n);
END $f$;

DO $cron$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'commission-fund-in-reconcile';
  PERFORM cron.schedule('commission-fund-in-reconcile', '7 * * * *',
                        'SELECT public.commission_reconcile_fund_ins(500);');
END $cron$;

SELECT (SELECT cutover_at FROM public.commission_gate_settings WHERE id) AS cutover_at,
       (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_proxy_agent_portfolio_commission','trg_proxy_agent_portfolio_topup_commission')) AS proxy_triggers_left,
       (SELECT count(*) FROM cron.job WHERE jobname = 'commission-fund-in-reconcile') AS cron_jobs;