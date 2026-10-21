-- merge_paidout_topups: compounding portfolios are triggered by their latest
-- compounding, not by an old payout.
--
-- Bug: the engine picked its trigger as "last approved Returns payout, else (for
-- monthly_compounding only) a compounding in the last 48h". A compounding
-- portfolio with any historic payout op (e.g. paid once before switching mode)
-- was judged by that old payout's 10-day grace window forever, so every later
-- top-up looked "too late" even though the portfolio compounds monthly.
-- Example: NABUUMA LINDA, WIP2603161838 — top-up 6 Oct, compounded 19 Oct, last
-- payout 17 Aug; skipped on 19 and 20 Oct and applied by hand on 21 Oct.
--
-- New rule for monthly_compounding / compound portfolios — a funded top-up
-- applies when EITHER:
--   * it was made before the portfolio's latest compounding (no 48h limit, so a
--     top-up that missed its window applies on the next run), or
--   * it was made within 10 days after an approved payout (unchanged).
-- Payout-mode portfolios: unchanged (10-day grace after the last approved payout).
-- Only ops still pending/awaiting_verification/approved are considered, so
-- already-applied (completed) top-ups are never touched. topup_op_is_funded
-- (20261016170000) still gates every op. Everything else is identical to
-- production as of 2026-10-21.

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
$function$;
