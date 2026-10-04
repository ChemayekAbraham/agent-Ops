-- Doc 188: parked top-ups on monthly_compounding portfolios never merged.
--
-- merge_paidout_topups() (cron merge-paidout-topups-7pm, 16:00 UTC) only merges a
-- parked portfolio_topup op when the portfolio has an approved/completed
-- roi_payout or supporter_platform_rewards op, and uses that op's reviewed_at as
-- "the Returns payout happened". A monthly_compounding portfolio never has such an
-- op: its Returns are compounded straight into principal by the COO action, which
-- records an audit_logs row (action_type = 'roi_compounded', record_id = portfolio).
-- v_last_payout was therefore always NULL for those portfolios and the function
-- skipped them forever (WPF-0853: UGX 100,000 parked 2026-09-30, compounded
-- 2026-10-02 07:31 UTC without it, still `approved`).
--
-- Fix (ROI-day rule, per CEO/Josh 2026-10-02): when a monthly_compounding portfolio
-- is compounded, every top-up already parked at that moment merges at the next
-- 16:00 UTC run, i.e. the same day. Only a roi_compounded event from the last 48h
-- counts and only ops created at/before it merge, so old backlog is NOT swept in
-- (see doc 188 for the list left for a decision). The payout-op path, ledger legs,
-- audit, notification and active-only filter are unchanged.
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
  v_grace_cutoff timestamptz;
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
      AND EXISTS (
        SELECT 1 FROM public.pending_wallet_operations po
        WHERE po.source_id = ip.id
          AND po.source_table = 'investor_portfolios'
          AND po.operation_type = 'portfolio_topup'
          AND po.status IN ('pending','awaiting_verification','approved')
      )
  LOOP
    SELECT max(po.reviewed_at) INTO v_last_payout
    FROM public.pending_wallet_operations po
    WHERE po.source_id = rec.id
      AND po.source_table = 'investor_portfolios'
      AND po.category IN ('roi_payout','supporter_platform_rewards')
      AND po.status IN ('approved','completed');

    IF v_last_payout IS NOT NULL THEN
      v_grace_cutoff := v_last_payout + make_interval(days => v_grace_days);
    ELSIF rec.roi_mode = 'monthly_compounding' THEN
      -- Compounding portfolios have no payout op; the compound event IS the payout.
      -- ROI-day rule: on the day the portfolio is compounded, every top-up that was
      -- already parked at that moment merges. Only a compound from the last 48h
      -- counts (so this never reaches back into older cycles' backlog), and only
      -- top-ups created at or before the compound (later ones wait for the next ROI).
      SELECT max(al.created_at) INTO v_last_compound
      FROM public.audit_logs al
      WHERE al.record_id = rec.id::text   -- audit_logs.record_id is text in production
        AND al.action_type = 'roi_compounded';

      IF v_last_compound IS NULL OR v_last_compound < v_now - interval '48 hours' THEN
        CONTINUE;
      END IF;

      v_last_payout := v_last_compound;
      v_grace_cutoff := v_last_compound + interval '1 second';
    ELSE
      CONTINUE;
    END IF;

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

    UPDATE public.investor_portfolios
    SET investment_amount = v_new_amount
    WHERE id = rec.id;

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
$function$;
