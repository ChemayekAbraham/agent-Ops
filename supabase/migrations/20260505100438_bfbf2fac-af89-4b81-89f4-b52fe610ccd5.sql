
-- 1) Re-create reseed_wallets_to_cached_balance with idempotency guard (today, Africa/Kampala).
--    The wallet leg MUST stay on a category that is NOT excluded by the strict-net filter
--    (i.e. NOT 'system_balance_correction' and NOT classification 'admin_correction'),
--    otherwise the user's strict ledger does not move and the anchor is silently a no-op.
CREATE OR REPLACE FUNCTION public.reseed_wallets_to_cached_balance(
  p_dry_run boolean DEFAULT true,
  p_max_users integer DEFAULT 100000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_batch_id uuid := gen_random_uuid();
  v_anchor_ts timestamptz := (date_trunc('day', (now() AT TIME ZONE 'Africa/Kampala'))) AT TIME ZONE 'Africa/Kampala';
  v_today_start timestamptz := v_anchor_ts;
  v_today_end timestamptz := v_anchor_ts + interval '1 day';
  v_rec record;
  v_count_up int := 0;
  v_count_down int := 0;
  v_total_up numeric := 0;
  v_total_down numeric := 0;
  v_skipped int := 0;
  v_reseed_id uuid;
  v_writeoff_id uuid;
  v_delta numeric;
BEGIN
  IF NOT (
    public.has_role(v_caller, 'cfo')
    OR public.has_role(v_caller, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'unauthorized: only CFO or super_admin can reseed';
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);
  PERFORM set_config('ledger.skip_bucket_sync', 'true', true);

  FOR v_rec IN
    WITH net AS (
      SELECT user_id,
             SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END) AS strict_net
      FROM public.general_ledger
      WHERE ledger_scope='wallet' AND user_id IS NOT NULL
        AND classification <> 'admin_correction'
        AND category <> 'system_balance_correction'
      GROUP BY user_id
    ),
    already AS (
      -- Idempotency: skip users already anchored today (Africa/Kampala).
      SELECT DISTINCT user_id
      FROM public.wallet_negative_reconciliation_log
      WHERE created_at >= v_today_start
        AND created_at <  v_today_end
    )
    SELECT w.user_id,
           w.withdrawable_balance::numeric AS cached,
           COALESCE(n.strict_net, 0)::numeric AS strict_net,
           (w.withdrawable_balance - COALESCE(n.strict_net,0))::numeric AS delta,
           (a.user_id IS NOT NULL) AS already_done
    FROM public.wallets w
    LEFT JOIN net n USING(user_id)
    LEFT JOIN already a USING(user_id)
    WHERE w.withdrawable_balance IS NOT NULL
      AND w.withdrawable_balance <> COALESCE(n.strict_net, 0)
    ORDER BY ABS(w.withdrawable_balance - COALESCE(n.strict_net,0)) DESC
    LIMIT GREATEST(p_max_users, 1)
  LOOP
    v_delta := v_rec.delta;
    IF v_delta = 0 THEN CONTINUE; END IF;

    IF v_rec.already_done THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF v_delta > 0 THEN
      v_count_up := v_count_up + 1;
      v_total_up := v_total_up + v_delta;
    ELSE
      v_count_down := v_count_down + 1;
      v_total_down := v_total_down + ABS(v_delta);
    END IF;

    IF p_dry_run THEN CONTINUE; END IF;

    IF v_delta > 0 THEN
      -- Cache > strict ledger → credit the WALLET ledger up to cached balance.
      INSERT INTO public.general_ledger (
        transaction_date, amount, direction, category, description,
        reference_id, user_id, source_table, ledger_scope,
        classification, transaction_group_id
      ) VALUES (
        v_anchor_ts, v_delta, 'cash_in', 'historical_balance_reseed',
        'Wallet ledger anchored to cached balance at 00:00 EAT',
        v_batch_id::text, v_rec.user_id, 'wallet_negative_reconciliation_log', 'wallet',
        'production', v_batch_id
      ) RETURNING id INTO v_reseed_id;

      INSERT INTO public.general_ledger (
        transaction_date, amount, direction, category, description,
        reference_id, user_id, source_table, ledger_scope,
        classification, transaction_group_id
      ) VALUES (
        v_anchor_ts, v_delta, 'cash_out', 'platform_loss_writeoff',
        'Anchor offset (platform write-off) for cached-balance reseed',
        v_batch_id::text, NULL, 'wallet_negative_reconciliation_log', 'platform',
        'production', v_batch_id
      ) RETURNING id INTO v_writeoff_id;

      INSERT INTO public.wallet_negative_reconciliation_log (
        batch_id, user_id, deficit_cleared, ledger_net_before,
        cached_withdrawable_before, reseed_ledger_id, writeoff_ledger_id, reconciled_by
      ) VALUES (
        v_batch_id, v_rec.user_id, v_delta, v_rec.strict_net,
        v_rec.cached, v_reseed_id, v_writeoff_id, v_caller
      );
    ELSE
      -- Strict ledger > cache → debit the WALLET ledger down to cached balance.
      INSERT INTO public.general_ledger (
        transaction_date, amount, direction, category, description,
        reference_id, user_id, source_table, ledger_scope,
        classification, transaction_group_id
      ) VALUES (
        v_anchor_ts, ABS(v_delta), 'cash_out', 'wallet_deduction_general_adjustment',
        'Wallet ledger anchored down to cached balance at 00:00 EAT',
        v_batch_id::text, v_rec.user_id, 'wallet_negative_reconciliation_log', 'wallet',
        'production', v_batch_id
      ) RETURNING id INTO v_reseed_id;

      INSERT INTO public.general_ledger (
        transaction_date, amount, direction, category, description,
        reference_id, user_id, source_table, ledger_scope,
        classification, transaction_group_id
      ) VALUES (
        v_anchor_ts, ABS(v_delta), 'cash_in', 'system_balance_correction',
        'Anchor offset (platform recovery) for cached-balance write-down',
        v_batch_id::text, NULL, 'wallet_negative_reconciliation_log', 'platform',
        'production', v_batch_id
      ) RETURNING id INTO v_writeoff_id;

      INSERT INTO public.wallet_negative_reconciliation_log (
        batch_id, user_id, deficit_cleared, ledger_net_before,
        cached_withdrawable_before, reseed_ledger_id, writeoff_ledger_id, reconciled_by
      ) VALUES (
        v_batch_id, v_rec.user_id, v_delta, v_rec.strict_net,
        v_rec.cached, v_reseed_id, v_writeoff_id, v_caller
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'batch_id', v_batch_id,
    'dry_run', p_dry_run,
    'anchor_ts', v_anchor_ts,
    'users_credited', v_count_up,
    'total_credited', v_total_up,
    'users_debited', v_count_down,
    'total_debited', v_total_down,
    'users_skipped_already_anchored_today', v_skipped
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reseed_wallets_to_cached_balance(boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reseed_wallets_to_cached_balance(boolean, integer) TO authenticated;

-- 2) Verification view: shows per-user anchor activity for today (Africa/Kampala).
CREATE OR REPLACE VIEW public.wallet_anchor_today_view
WITH (security_invoker = true)
AS
WITH today AS (
  SELECT (date_trunc('day', (now() AT TIME ZONE 'Africa/Kampala'))) AT TIME ZONE 'Africa/Kampala' AS d_start
),
strict_net AS (
  SELECT user_id,
         SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END) AS strict_net
  FROM public.general_ledger
  WHERE ledger_scope='wallet' AND user_id IS NOT NULL
    AND classification <> 'admin_correction'
    AND category <> 'system_balance_correction'
  GROUP BY user_id
)
SELECT
  l.user_id,
  p.full_name,
  p.phone,
  l.batch_id,
  l.cached_withdrawable_before AS cached_at_anchor,
  l.ledger_net_before          AS strict_net_at_anchor,
  l.deficit_cleared            AS delta_applied,
  l.reseed_ledger_id           AS wallet_leg_id,
  l.writeoff_ledger_id         AS platform_leg_id,
  COALESCE(s.strict_net, 0)    AS strict_net_now,
  w.withdrawable_balance       AS cached_now,
  l.created_at
FROM public.wallet_negative_reconciliation_log l
LEFT JOIN public.profiles p ON p.id = l.user_id
LEFT JOIN public.wallets  w ON w.user_id = l.user_id
LEFT JOIN strict_net      s ON s.user_id = l.user_id
WHERE l.created_at >= (SELECT d_start FROM today)
ORDER BY l.created_at DESC;

GRANT SELECT ON public.wallet_anchor_today_view TO authenticated;
