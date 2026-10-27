-- Portfolio Return hold (temporary, CFO-controlled).                                     NOT APPLIED — needs CFO approval.
--
-- While a portfolio is under investigation, nothing may change its principal, Return schedule or status, and no
-- Return, compound, split or top-up may be posted for it. Placing / releasing a hold is a CFO-approver action
-- (is_cfo_approver), audited in audit_logs. This migration creates the mechanism only: it holds NO portfolio.
--
-- While a portfolio is held:
--   BLOCKED  any new pending_wallet_operations row for it (Return payout request, top-up, wallet-to-investment, ...);
--            any ledger leg sourced to it that is a Return (roi_expense, roi_reinvestment, roi_wallet_credit,
--            roi_payout), that takes money out of a wallet into it (wallet-scope cash_out), or that activates capital
--            (partner_funding platform cash_in). This stops approval of requests queued before the hold, compound,
--            split, instant / manual top-ups and merges, from every route (browser, edge function, cron, SQL);
--            any change to principal, Return schedule, mode, rate, status, term or dates, and DELETE.
--   SKIPPED  the daily merge of parked top-ups (merge_paidout_topups): the held portfolio is left out and the run
--            continues for every other portfolio (that function has no per-row error handling, so it must skip).
--   ALLOWED  refunds back to the partner's wallet (wallet-scope cash_in), name / label edits, reads, everything on
--            other portfolios. Wallet WITHDRAWALS are NOT blocked: the hold is on the portfolio, not the wallet.
-- Corrections to a held portfolio: release the hold, post the CFO-approved correction, place the hold again (each
-- step audited). Return credits NOT sourced to the portfolio (e.g. a CFO direct credit coded as a Return) are not
-- seen by this hold; the Return-cycle guard (20261024140000) closes that route.
--
-- Rollback: supabase/rollbacks/20261024160000_portfolio_return_hold.rollback.sql (restores merge_paidout_topups
-- exactly; drops the triggers and functions; keeps the holds table as an audit record).

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.merge_paidout_topups()'::regprocedure)) <> 'b9e3b9ce7d300f6fe080b9f87dfee614' THEN
    RAISE EXCEPTION 'merge_paidout_topups changed in production since 2026-10-24; re-derive this migration';
  END IF;
  IF to_regprocedure('public.is_cfo_approver(uuid)') IS NULL OR to_regprocedure('public.staff_mfa_ok()') IS NULL THEN
    RAISE EXCEPTION 'is_cfo_approver(uuid) or staff_mfa_ok() is missing';
  END IF;
END $pre$;

CREATE TABLE public.portfolio_return_holds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id   uuid NOT NULL REFERENCES public.investor_portfolios(id),
  reason         text NOT NULL CHECK (length(btrim(reason)) >= 20),
  held_by        uuid NOT NULL,
  held_at        timestamptz NOT NULL DEFAULT now(),
  released_by    uuid,
  released_at    timestamptz,
  release_reason text,
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE UNIQUE INDEX portfolio_return_holds_one_active ON public.portfolio_return_holds (portfolio_id) WHERE released_at IS NULL;

ALTER TABLE public.portfolio_return_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.portfolio_return_holds FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.portfolio_return_holds TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.portfolio_return_holds TO service_role;
-- Writes only through the two CFO functions below (no insert/update/delete policy for authenticated).
CREATE POLICY portfolio_return_holds_staff_read ON public.portfolio_return_holds FOR SELECT TO authenticated
  USING (public.is_cfo_approver(auth.uid())
         OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND coalesce(ur.enabled, true)
                     AND ur.role::text IN ('cfo', 'coo', 'ceo', 'super_admin', 'partner_ops', 'financial_ops', 'manager')));
CREATE POLICY mfa_required_for_staff ON public.portfolio_return_holds AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

CREATE FUNCTION public.is_portfolio_on_hold(p_portfolio_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_portfolio_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.portfolio_return_holds h WHERE h.portfolio_id = p_portfolio_id AND h.released_at IS NULL)
$$;

CREATE FUNCTION public.place_portfolio_return_hold(p_portfolio_id uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid; v_code text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_cfo_approver(v_uid) THEN
    RAISE EXCEPTION 'Only the CFO approver can place a portfolio Return hold' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 20 THEN
    RAISE EXCEPTION 'A hold needs a reason of at least 20 characters' USING ERRCODE = '22023';
  END IF;
  -- Lock the portfolio row so a hold and an in-flight change on the same portfolio are serialised.
  SELECT portfolio_code INTO v_code FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = '22023'; END IF;
  IF public.is_portfolio_on_hold(p_portfolio_id) THEN
    RAISE EXCEPTION 'Portfolio % is already on hold', v_code USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.portfolio_return_holds (portfolio_id, reason, held_by) VALUES (p_portfolio_id, btrim(p_reason), v_uid)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_uid, 'portfolio_return_hold_placed', 'investor_portfolios', p_portfolio_id::text, 'hold', btrim(p_reason),
          jsonb_build_object('hold_id', v_id, 'portfolio_id', p_portfolio_id, 'portfolio_code', v_code));
  RETURN v_id;
END $$;

CREATE FUNCTION public.release_portfolio_return_hold(p_portfolio_id uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid(); v_id uuid; v_code text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_cfo_approver(v_uid) THEN
    RAISE EXCEPTION 'Only the CFO approver can release a portfolio Return hold' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 20 THEN
    RAISE EXCEPTION 'A release needs a reason of at least 20 characters' USING ERRCODE = '22023';
  END IF;
  UPDATE public.portfolio_return_holds SET released_at = now(), released_by = v_uid, release_reason = btrim(p_reason)
   WHERE portfolio_id = p_portfolio_id AND released_at IS NULL
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'Portfolio is not on hold' USING ERRCODE = '22023'; END IF;
  SELECT portfolio_code INTO v_code FROM public.investor_portfolios WHERE id = p_portfolio_id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_uid, 'portfolio_return_hold_released', 'investor_portfolios', p_portfolio_id::text, 'release', btrim(p_reason),
          jsonb_build_object('hold_id', v_id, 'portfolio_id', p_portfolio_id, 'portfolio_code', v_code));
  RETURN v_id;
END $$;

-- Portfolio row: no change to money / schedule / status fields, no delete. Named trg_zz_ so it runs after the other
-- BEFORE triggers and checks the final row.
CREATE FUNCTION public.enforce_portfolio_return_hold() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.is_portfolio_on_hold(OLD.id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PORTFOLIO_ON_HOLD: portfolio % is on a CFO hold and cannot be deleted', OLD.portfolio_code USING ERRCODE = '42501';
  END IF;
  IF (NEW.investment_amount, NEW.next_roi_date, NEW.roi_mode, NEW.roi_percentage, NEW.total_roi_earned, NEW.payout_day,
      NEW.status, NEW.duration_months, NEW.maturity_date, NEW.auto_reinvest, NEW.created_at, NEW.investor_id)
     IS DISTINCT FROM
     (OLD.investment_amount, OLD.next_roi_date, OLD.roi_mode, OLD.roi_percentage, OLD.total_roi_earned, OLD.payout_day,
      OLD.status, OLD.duration_months, OLD.maturity_date, OLD.auto_reinvest, OLD.created_at, OLD.investor_id) THEN
    RAISE EXCEPTION 'PORTFOLIO_ON_HOLD: portfolio % is on a CFO hold; its principal, Return schedule and status cannot change', OLD.portfolio_code
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_zz_portfolio_return_hold BEFORE UPDATE OR DELETE ON public.investor_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.enforce_portfolio_return_hold();

-- Ledger: no Return, no money into the portfolio, no capital activation.
CREATE FUNCTION public.enforce_portfolio_return_hold_ledger() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NEW.source_table IS DISTINCT FROM 'investor_portfolios' OR NEW.source_id IS NULL
     OR NOT public.is_portfolio_on_hold(NEW.source_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.category IN ('roi_expense', 'roi_reinvestment', 'roi_wallet_credit', 'roi_payout')
     OR (NEW.ledger_scope = 'wallet' AND NEW.direction = 'cash_out')
     OR (NEW.category = 'partner_funding' AND NEW.ledger_scope = 'platform' AND NEW.direction = 'cash_in') THEN
    RAISE EXCEPTION 'PORTFOLIO_ON_HOLD: portfolio % is on a CFO hold; % (%/%) is not allowed', NEW.source_id, NEW.category, NEW.ledger_scope, NEW.direction
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_portfolio_return_hold_ledger BEFORE INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.enforce_portfolio_return_hold_ledger();

-- Requests: nothing new can be queued against a held portfolio.
CREATE FUNCTION public.enforce_portfolio_return_hold_request() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NEW.source_table = 'investor_portfolios' AND public.is_portfolio_on_hold(NEW.source_id) THEN
    RAISE EXCEPTION 'PORTFOLIO_ON_HOLD: portfolio % is on a CFO hold; no new request (%) can be queued', NEW.source_id, coalesce(NEW.category, NEW.operation_type)
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_aa_portfolio_return_hold_request BEFORE INSERT ON public.pending_wallet_operations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_portfolio_return_hold_request();

-- Daily merge of parked top-ups: identical to production except that held portfolios are skipped.
CREATE OR REPLACE FUNCTION public.merge_paidout_topups()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_grace_days CONSTANT int := 10;
  v_now timestamptz := now();
  v_merged_portfolios int := 0;
  v_merged_ops int := 0;
  v_merged_amount numeric := 0;
  rec record;
  v_last_payout timestamptz;
  v_last_compound timestamptz;
  v_payout_cutoff timestamptz;
  v_is_compounding boolean;
  v_trigger text;
  v_total numeric;
  v_cnt int;
  v_partner uuid;
  v_prev_amount numeric;
  v_new_amount numeric;
  v_label text;
  v_op_ids uuid[];
BEGIN
  FOR rec IN
    SELECT ip.id, ip.investment_amount, ip.portfolio_code, ip.account_name,
           ip.investor_id, ip.agent_id, ip.roi_mode
    FROM public.investor_portfolios ip
    WHERE ip.status = 'active'
      AND NOT public.is_portfolio_on_hold(ip.id)   -- portfolio Return hold: skip, never fail the whole run
      AND EXISTS (
        SELECT 1 FROM public.pending_wallet_operations po
        WHERE po.source_id = ip.id
          AND po.source_table = 'investor_portfolios'
          AND po.operation_type = 'portfolio_topup'
          AND po.status IN ('pending','awaiting_verification','approved')
          AND public.topup_op_is_funded(po.status, po.metadata)
      )
  LOOP
    v_is_compounding := rec.roi_mode IN ('monthly_compounding', 'compound');

    SELECT max(po.reviewed_at) INTO v_last_payout
    FROM public.pending_wallet_operations po
    WHERE po.source_id = rec.id
      AND po.source_table = 'investor_portfolios'
      AND po.category IN ('roi_payout','supporter_platform_rewards')
      AND po.status IN ('approved','completed');

    v_last_compound := NULL;
    IF v_is_compounding THEN
      -- The compound event IS the Returns event for these portfolios.
      SELECT max(al.created_at) INTO v_last_compound
      FROM public.audit_logs al
      WHERE al.record_id = rec.id::text   -- audit_logs.record_id is text in production
        AND al.action_type = 'roi_compounded';
    END IF;

    IF v_last_payout IS NULL AND v_last_compound IS NULL THEN
      CONTINUE;
    END IF;

    v_payout_cutoff := CASE WHEN v_last_payout IS NOT NULL
                            THEN v_last_payout + make_interval(days => v_grace_days) END;

    SELECT array_agg(po.id), count(*), coalesce(sum(po.amount),0)
      INTO v_op_ids, v_cnt, v_total
    FROM public.pending_wallet_operations po
    WHERE po.source_id = rec.id
      AND po.source_table = 'investor_portfolios'
      AND po.operation_type = 'portfolio_topup'
      AND po.status IN ('pending','awaiting_verification','approved')
      AND public.topup_op_is_funded(po.status, po.metadata)
      AND (
        (v_payout_cutoff IS NOT NULL AND po.created_at < v_payout_cutoff)
        OR (v_last_compound IS NOT NULL AND po.created_at < v_last_compound)
      );

    IF v_op_ids IS NULL OR v_total <= 0 THEN
      CONTINUE;
    END IF;

    -- Which event released them (for the audit trail).
    v_trigger := CASE
      WHEN v_last_compound IS NOT NULL
           AND (v_last_payout IS NULL OR v_last_compound >= v_last_payout) THEN 'compound'
      ELSE 'payout' END;

    v_partner := coalesce(rec.investor_id, rec.agent_id);
    v_prev_amount := coalesce(rec.investment_amount, 0);
    v_new_amount := v_prev_amount + v_total;
    v_label := coalesce(rec.account_name, rec.portfolio_code);

    UPDATE public.investor_portfolios
    SET investment_amount = v_new_amount
    WHERE id = rec.id;

    UPDATE public.pending_wallet_operations
    SET status = 'completed',
        reviewed_at = v_now,
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'merged_at', v_now,
          'merge_trigger', 'cron_merge_paidout',
          'merged_after_payout_at', coalesce(greatest(v_last_compound, v_last_payout), v_last_payout),
          'merged_on_event', v_trigger,
          'grace_days', v_grace_days
        )
    WHERE id = ANY(v_op_ids);

    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_partner,
          'amount', v_total,
          'direction', 'cash_out',
          'category', 'pending_portfolio_topup',
          'source_table', 'investor_portfolios',
          'source_id', rec.id,
          'description', format('Cron merge: %s parked top-up(s) into %s after Returns %s', v_cnt, v_label, v_trigger),
          'currency', 'UGX',
          'ledger_scope', 'platform',
          'transaction_date', v_now
        ),
        jsonb_build_object(
          'user_id', v_partner,
          'amount', v_total,
          'direction', 'cash_in',
          'category', 'partner_funding',
          'source_table', 'investor_portfolios',
          'source_id', rec.id,
          'description', format('%s parked top-up(s) merged into %s - capital activated post-payout', v_cnt, v_label),
          'currency', 'UGX',
          'ledger_scope', 'platform',
          'transaction_date', v_now
        )
      )
    );

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
    VALUES (
      NULL,
      'cron_merge_paidout_topups',
      'investor_portfolios',
      rec.id,
      'Auto-merged parked top-ups after the portfolio''s Returns event',
      jsonb_build_object(
        'partner_id', v_partner,
        'count', v_cnt,
        'total_merged', v_total,
        'previous_capital', v_prev_amount,
        'new_capital', v_new_amount,
        'op_ids', to_jsonb(v_op_ids),
        'last_payout_approved_at', v_last_payout,
        'last_compounded_at', v_last_compound,
        'merged_on_event', v_trigger,
        'grace_days', v_grace_days,
        'trigger', 'cron_merge_paidout',
        'source', 'cron'
      )
    );

    IF v_partner IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        v_partner,
        '🔄 Top-Ups Merged Into Capital',
        format('%s pending deposit(s) totaling UGX %s have been added to "%s" following your Returns. New capital: UGX %s.',
          v_cnt, to_char(v_total, 'FM999,999,999,999'), v_label, to_char(v_new_amount, 'FM999,999,999,999')),
        'success',
        jsonb_build_object(
          'portfolio_id', rec.id,
          'total_merged', v_total,
          'new_capital', v_new_amount,
          'trigger', 'cron_merge_paidout'
        )
      );
    END IF;

    v_merged_portfolios := v_merged_portfolios + 1;
    v_merged_ops := v_merged_ops + v_cnt;
    v_merged_amount := v_merged_amount + v_total;
  END LOOP;

  RETURN jsonb_build_object(
    'merged_portfolios', v_merged_portfolios,
    'merged_ops', v_merged_ops,
    'merged_amount', v_merged_amount,
    'ran_at', v_now
  );
END;
$function$
;

REVOKE EXECUTE ON FUNCTION public.is_portfolio_on_hold(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_portfolio_on_hold(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.place_portfolio_return_hold(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_portfolio_return_hold(uuid, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.release_portfolio_return_hold(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_portfolio_return_hold(uuid, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.enforce_portfolio_return_hold() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_portfolio_return_hold_ledger() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_portfolio_return_hold_request() FROM PUBLIC, anon, authenticated;
