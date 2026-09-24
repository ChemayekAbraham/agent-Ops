-- Close the "admin does the work, proxy agent gets paid" glitch.
--
-- credit_proxy_agent_portfolio_commission() only ever checked
-- proxy_agent_assignments (an active, approved, managed relationship record).
-- That record answers "who administratively owns this partner", not "did this
-- agent actually bring this partner in" — and every portfolio-creation /
-- top-up write path is an admin/executive tool (coo-invest-for-partner,
-- manager-portfolio-topup, coo-wallet-to-portfolio, approve-portfolio-topup),
-- not something the proxy agent triggers themselves. So any Partner Ops action
-- on a managed partner's account paid the assigned proxy agent a commission
-- regardless of who did the sourcing work.
--
-- Fix: require proof of the agent's own origination — an activated/fulfilled
-- promissory_notes row linking that specific agent to that specific partner —
-- before any commission is queued. proxy_agent_assignments still decides WHO
-- would be paid (routing); the promissory note now decides WHETHER anyone is
-- paid at all (eligibility).

CREATE INDEX IF NOT EXISTS idx_promissory_notes_agent_partner
  ON public.promissory_notes (agent_id, partner_user_id)
  WHERE partner_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.credit_proxy_agent_portfolio_commission(
  p_partner_id uuid, p_base_amount numeric, p_kind text,
  p_source_table text, p_source_id uuid, p_dedupe_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_proxy_agent_id uuid;
  v_assignment_id uuid;
  v_rate numeric;
  v_amount numeric;
  v_idem text;
  v_queue_id uuid;
BEGIN
  IF p_partner_id IS NULL OR p_source_id IS NULL OR COALESCE(p_base_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','no_base_amount');
  END IF;

  IF p_kind NOT IN ('portfolio_creation','portfolio_topup') THEN
    RETURN jsonb_build_object('status','skipped','reason','unsupported_kind');
  END IF;

  SELECT a.agent_id, a.id
    INTO v_proxy_agent_id, v_assignment_id
  FROM public.proxy_agent_assignments a
  WHERE a.beneficiary_id = p_partner_id
    AND a.is_active = true
    AND COALESCE(a.is_managed_account, false) = true
    AND COALESCE(a.approval_status, 'pending') = 'approved'
    AND a.agent_id IS NOT NULL
    AND a.agent_id <> p_partner_id
    AND (a.expires_at IS NULL OR a.expires_at > now())
  ORDER BY a.approved_at DESC NULLS LAST, a.created_at DESC NULLS LAST, a.id
  LIMIT 1;

  IF v_proxy_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_active_managed_proxy');
  END IF;

  -- Eligibility, not routing: this agent only earns on this partner if they
  -- are the one who actually brought them in, proven by an activated (or
  -- since-fulfilled) promissory note naming both. An admin creating or
  -- topping up the portfolio in the Partnership Operations dashboard is not,
  -- by itself, evidence of that.
  IF NOT EXISTS (
    SELECT 1 FROM public.promissory_notes pn
    WHERE pn.agent_id = v_proxy_agent_id
      AND pn.partner_user_id = p_partner_id
      AND pn.status IN ('activated','fulfilled')
  ) THEN
    RETURN jsonb_build_object('status','skipped','reason','no_promissory_note_for_partner',
                              'agent_id', v_proxy_agent_id, 'partner_id', p_partner_id);
  END IF;

  v_rate := CASE p_kind
    WHEN 'portfolio_creation' THEN 0.02
    WHEN 'portfolio_topup' THEN 0.01
    ELSE 0 END;

  v_amount := round(p_base_amount * v_rate);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','amount_rounds_to_zero');
  END IF;

  v_idem := 'proxy_agent_portfolio_commission:' || p_kind || ':' || p_source_table || ':'
            || COALESCE(p_dedupe_key, p_source_id::text);

  IF EXISTS (SELECT 1 FROM public.proxy_commission_queue q WHERE q.idempotency_key = v_idem) THEN
    RETURN jsonb_build_object('status','skipped','reason','duplicate_source');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.idempotency_key = v_idem
      AND g.ledger_scope = 'wallet'
      AND g.direction = 'cash_in'
  ) THEN
    RETURN jsonb_build_object('status','skipped','reason','duplicate_source');
  END IF;

  INSERT INTO public.proxy_commission_queue
    (kind, agent_id, partner_id, assignment_id, base_amount, rate, amount,
     source_table, source_id, idempotency_key, status, auto_approved)
  VALUES (p_kind, v_proxy_agent_id, p_partner_id, v_assignment_id, p_base_amount, v_rate, v_amount,
          p_source_table, p_source_id::text, v_idem, 'pending', true)
  RETURNING id INTO v_queue_id;

  RETURN public.pay_proxy_commission_queue_item(v_queue_id)
         || jsonb_build_object('queue_id', v_queue_id, 'auto_approved', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.credit_proxy_agent_portfolio_commission(uuid,numeric,text,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_proxy_agent_portfolio_commission(uuid,numeric,text,text,uuid,text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Close the double-fire: one top-up, one commission.
--
-- A verified external/wallet top-up is approved as a `pending_wallet_operations`
-- row (status -> 'approved'), which fires trg_proxy_agent_portfolio_topup_commission
-- and pays 1% right away. The money is deliberately NOT applied to
-- investor_portfolios.investment_amount at that point ("parked until next ROI
-- cycle"). Later, merge_paidout_topups() sums up every parked op for a
-- portfolio and does ONE bulk UPDATE investor_portfolios SET investment_amount
-- = ... for the total. That single UPDATE fires trg_proxy_agent_portfolio_commission
-- (the OTHER trigger, on investor_portfolios) with the same money as a "topup"
-- again, using a different source_table so nothing dedupes it. Net effect:
-- every top-up that goes through FinOps verification pays out twice.
--
-- Fix: merge_paidout_topups() marks its own investment_amount write with a
-- transaction-local flag; the investor_portfolios trigger's topup branch
-- skips crediting anything while that flag is set, because that money was
-- already commissioned individually at approval time. Portfolio *creation*
-- (the INSERT / first-activation branches) is untouched — a brand-new
-- portfolio is never something merge_paidout_topups() writes.

CREATE OR REPLACE FUNCTION public.trg_proxy_agent_portfolio_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_delta numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'active' AND coalesce(NEW.investment_amount, 0) > 0 THEN
      PERFORM public.try_credit_proxy_agent_portfolio_commission(
        NEW.investor_id,
        NEW.investment_amount,
        'portfolio_creation',
        'investor_portfolios',
        NEW.id,
        NEW.id::text
      );
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.status = 'active'
     AND coalesce(OLD.status, '') <> 'active'
     AND coalesce(NEW.investment_amount, 0) > 0 THEN
    PERFORM public.try_credit_proxy_agent_portfolio_commission(
      NEW.investor_id,
      NEW.investment_amount,
      'portfolio_creation',
      'investor_portfolios',
      NEW.id,
      NEW.id::text
    );
    RETURN NULL;
  END IF;

  v_delta := coalesce(NEW.investment_amount, 0) - coalesce(OLD.investment_amount, 0);
  IF v_delta > 0 AND NEW.status = 'active'
     AND coalesce(current_setting('welile.proxy_commission_merge_in_progress', true), '') <> 'true' THEN
    PERFORM public.try_credit_proxy_agent_portfolio_commission(
      NEW.investor_id,
      v_delta,
      'portfolio_topup',
      'investor_portfolios',
      NEW.id,
      NEW.id::text || ':' || round(coalesce(NEW.investment_amount, 0))::text
    );
  END IF;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trg_proxy_agent_portfolio_commission() FROM PUBLIC, anon, authenticated;

-- merge_paidout_topups(): identical body to the version in
-- 20260909120000_..., plus one line marking the investment_amount write so
-- the trigger above knows this money was already commissioned.
CREATE OR REPLACE FUNCTION public.merge_paidout_topups()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grace_days CONSTANT int := 10;
  v_now timestamptz := now();
  v_merged_portfolios int := 0;
  v_merged_ops int := 0;
  v_merged_amount numeric := 0;
  rec record;
  v_last_payout timestamptz;
  v_grace_cutoff timestamptz;
  v_total numeric;
  v_cnt int;
  v_partner uuid;
  v_prev_amount numeric;
  v_new_amount numeric;
  v_label text;
  v_op_ids uuid[];
BEGIN
  -- Transaction-local: cleared automatically when this call commits. Tells
  -- trg_proxy_agent_portfolio_commission that any investment_amount bump it
  -- sees in this transaction is capital consolidation, not a new top-up —
  -- the 1% was already paid when each op was individually approved.
  PERFORM set_config('welile.proxy_commission_merge_in_progress', 'true', true);

  FOR rec IN
    SELECT ip.id, ip.investment_amount, ip.portfolio_code, ip.account_name,
           ip.investor_id, ip.agent_id
    FROM public.investor_portfolios ip
    WHERE ip.status = 'active'
      AND EXISTS (
        SELECT 1 FROM public.pending_wallet_operations po
        WHERE po.source_id = ip.id
          AND po.source_table = 'investor_portfolios'
          AND po.operation_type = 'portfolio_topup'
          AND po.status IN ('pending','awaiting_verification','approved')
      )
  LOOP
    -- When was this portfolio's Returns payout last APPROVED by Financial Ops?
    SELECT max(po.reviewed_at) INTO v_last_payout
    FROM public.pending_wallet_operations po
    WHERE po.source_id = rec.id
      AND po.source_table = 'investor_portfolios'
      AND po.category IN ('roi_payout','supporter_platform_rewards')
      AND po.status IN ('approved','completed');

    -- No approved payout yet -> keep the top-up parked
    IF v_last_payout IS NULL THEN
      CONTINUE;
    END IF;

    v_grace_cutoff := v_last_payout + make_interval(days => v_grace_days);

    -- Merge top-ups parked within v_grace_days of that approved payout
    -- (= same-cycle auto-apply). Anything parked later stays put and only
    -- merges once the NEXT cycle's payout is approved and its own
    -- v_grace_days window is evaluated.
    SELECT array_agg(po.id), count(*), coalesce(sum(po.amount),0)
      INTO v_op_ids, v_cnt, v_total
    FROM public.pending_wallet_operations po
    WHERE po.source_id = rec.id
      AND po.source_table = 'investor_portfolios'
      AND po.operation_type = 'portfolio_topup'
      AND po.status IN ('pending','awaiting_verification','approved')
      AND po.created_at < v_grace_cutoff;

    IF v_op_ids IS NULL OR v_total <= 0 THEN
      CONTINUE;
    END IF;

    v_partner := coalesce(rec.investor_id, rec.agent_id);
    v_prev_amount := coalesce(rec.investment_amount, 0);
    v_new_amount := v_prev_amount + v_total;
    v_label := coalesce(rec.account_name, rec.portfolio_code);

    -- 1. Activate the parked capital into portfolio principal
    UPDATE public.investor_portfolios
    SET investment_amount = v_new_amount
    WHERE id = rec.id;

    -- 2. Mark the parked top-ups as completed
    UPDATE public.pending_wallet_operations
    SET status = 'completed',
        reviewed_at = v_now,
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'merged_at', v_now,
          'merge_trigger', 'cron_merge_paidout',
          'merged_after_payout_at', v_last_payout,
          'grace_days', v_grace_days
        )
    WHERE id = ANY(v_op_ids);

    -- 3. Balanced platform ledger pair (pending_portfolio_topup -> partner_funding)
    PERFORM public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_partner,
          'amount', v_total,
          'direction', 'cash_out',
          'category', 'pending_portfolio_topup',
          'source_table', 'investor_portfolios',
          'source_id', rec.id,
          'description', format('Cron merge: %s parked top-up(s) into %s within %s-day grace window of Returns payout', v_cnt, v_label, v_grace_days),
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

    -- 4. Audit trail
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
    VALUES (
      NULL,
      'cron_merge_paidout_topups',
      'investor_portfolios',
      rec.id,
      'Auto-merged parked top-ups within grace window of FinOps-approved Returns payout',
      jsonb_build_object(
        'partner_id', v_partner,
        'count', v_cnt,
        'total_merged', v_total,
        'previous_capital', v_prev_amount,
        'new_capital', v_new_amount,
        'op_ids', to_jsonb(v_op_ids),
        'last_payout_approved_at', v_last_payout,
        'grace_days', v_grace_days,
        'trigger', 'cron_merge_paidout',
        'source', 'cron'
      )
    );

    -- 5. Notify the partner
    IF v_partner IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        v_partner,
        '🔄 Top-Ups Merged Into Capital',
        format('%s pending deposit(s) totaling UGX %s have been added to "%s" following your Returns payout. New capital: UGX %s.',
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
$$;

REVOKE ALL ON FUNCTION public.merge_paidout_topups() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_paidout_topups() TO service_role;
