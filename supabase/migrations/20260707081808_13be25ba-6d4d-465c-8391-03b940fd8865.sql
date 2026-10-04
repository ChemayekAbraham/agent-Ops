-- 1) Add raw (pre-hold, pre-clamp) bucket figures to the authoritative wallet engine.
--    Existing fields are unchanged; only new *_raw fields are added.
CREATE OR REPLACE FUNCTION public.get_user_wallet_view(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_anchor_at       timestamptz;
  v_is_agent        boolean := false;
  v_withdrawable_raw numeric := 0;
  v_float_raw       numeric := 0;
  v_advance_raw     numeric := 0;
  v_holds           numeric := 0;
  v_withdrawable    numeric := 0;
  v_float           numeric := 0;
  v_advance         numeric := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'user_id', NULL, 'withdrawable', 0, 'float_balance', 0,
      'advance_balance', 0, 'pending_holds', 0, 'total_visible', 0,
      'withdrawable_raw', 0, 'float_raw', 0, 'advance_raw', 0
    );
  END IF;

  SELECT anchor_at INTO v_anchor_at
  FROM public.wallet_fresh_start_anchors
  WHERE user_id = p_user_id
  ORDER BY anchor_at DESC
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = p_user_id AND role = 'agent' AND COALESCE(enabled, true) = true
  ) INTO v_is_agent;

  WITH routed AS (
    SELECT
      CASE WHEN gl.direction IN ('cash_in','credit') THEN 1 ELSE -1 END AS sign,
      gl.amount,
      CASE
        WHEN gl.wallet_bucket IN ('withdrawable','float','advance_credit','advance_repayment')
          THEN gl.wallet_bucket
        WHEN gl.wallet_bucket IS NULL THEN
          CASE
            WHEN v_is_agent AND gl.direction IN ('cash_in','credit')
                 AND gl.category IN (
                   'cfo_direct_credit','pool_capital_received','partner_funding',
                   'supporter_capital','supporter_rent_fund','manager_credit'
                 ) THEN 'float'
            WHEN v_is_agent AND gl.direction IN ('cash_out','debit')
                 AND gl.category IN (
                   'agent_proxy_investment','coo_proxy_investment',
                   'pending_portfolio_topup','proxy_partner_withdrawal',
                   'rent_payment_for_tenant','rent_obligation','cfo_direct_credit'
                 ) THEN 'float'
            WHEN gl.category IN (
                   'agent_float_deposit','agent_float_assignment','agent_float_topup',
                   'agent_float_funding','agent_float_used_for_rent','agent_float_used',
                   'agent_float_settlement','agent_landlord_payout','rent_disbursement','rent_float_funding'
                 ) THEN 'float'
            WHEN gl.category IN ('agent_advance_credit','salary_advance')
                 AND gl.direction IN ('cash_in','credit') THEN 'advance_credit'
            WHEN gl.category IN ('agent_advance_repayment','salary_advance_repayment','debt_recovery')
                 AND gl.direction IN ('cash_out','debit') THEN 'advance_repayment'
            ELSE 'withdrawable'
          END
        ELSE NULL
      END AS bucket
    FROM public.general_ledger gl
    WHERE gl.user_id = p_user_id
      AND gl.ledger_scope = 'wallet'
      AND gl.direction IN ('cash_in','credit','cash_out','debit')
      AND (
        gl.classification IS NULL
        OR gl.classification = 'production'
        OR (
          gl.classification = 'admin_correction'
          AND gl.category = 'system_balance_correction'
          AND gl.direction IN ('debit','cash_out')
        )
      )
      AND (v_anchor_at IS NULL OR gl.created_at >= v_anchor_at)
  )
  SELECT
    COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN sign * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket = 'float' THEN sign * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket IN ('advance_credit','advance_repayment') THEN sign * amount ELSE 0 END), 0)
  INTO v_withdrawable_raw, v_float_raw, v_advance_raw
  FROM routed;

  SELECT COALESCE(SUM(wr.amount), 0)
    INTO v_holds
  FROM public.withdrawal_requests wr
  WHERE wr.status IN ('pending','requested','manager_approved','processing','approved')
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger g
      WHERE g.source_table = 'withdrawal_requests' AND g.source_id = wr.id
        AND g.ledger_scope = 'wallet' AND g.direction IN ('cash_out','debit')
    )
    AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
    AND (
      CASE
        WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
        ELSE wr.user_id
      END
    ) = p_user_id;

  v_withdrawable := GREATEST(0, v_withdrawable_raw - v_holds);
  v_float        := GREATEST(0, v_float_raw);
  v_advance      := GREATEST(0, v_advance_raw);

  RETURN jsonb_build_object(
    'user_id',          p_user_id,
    'withdrawable',     v_withdrawable,
    'float_balance',    v_float,
    'advance_balance',  v_advance,
    'pending_holds',    v_holds,
    'total_visible',    v_withdrawable + v_float,
    'withdrawable_raw', v_withdrawable_raw,
    'float_raw',        v_float_raw,
    'advance_raw',      v_advance_raw
  );
END;
$function$;

-- 2) Pivot trigger now derives buckets straight from the authoritative engine (raw),
--    so the pivot table can never diverge from the live wallet view again.
CREATE OR REPLACE FUNCTION public.tg_ledger_pivot_apply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
  v_w numeric := 0;
  v_f numeric := 0;
  v_a numeric := 0;
BEGIN
  IF NEW.user_id IS NULL OR COALESCE(NEW.ledger_scope,'wallet') <> 'wallet' THEN
    RETURN NEW;
  END IF;

  v := public.get_user_wallet_view(NEW.user_id);
  v_w := COALESCE((v->>'withdrawable_raw')::numeric, 0);
  v_f := COALESCE((v->>'float_raw')::numeric, 0);
  v_a := COALESCE((v->>'advance_raw')::numeric, 0);

  INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
    VALUES (NEW.user_id, 'withdrawable', v_w, now())
    ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();
  INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
    VALUES (NEW.user_id, 'float', v_f, now())
    ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();
  INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
    VALUES (NEW.user_id, 'advance', v_a, now())
    ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();

  RETURN NEW;
END;
$function$;

-- 3) Drift view compares the pivot table against the authoritative engine's RAW
--    (pre-hold) figures, so in-flight pending withdrawals no longer create false drift.
CREATE OR REPLACE VIEW public.wallet_pivot_drift_view AS
WITH p AS (
  SELECT ledger_balance_pivot.user_id,
    sum(CASE WHEN ledger_balance_pivot.bucket = 'withdrawable' THEN ledger_balance_pivot.balance_sum ELSE 0::numeric END) AS pivot_withdrawable,
    sum(CASE WHEN ledger_balance_pivot.bucket = 'float' THEN ledger_balance_pivot.balance_sum ELSE 0::numeric END) AS pivot_float,
    sum(CASE WHEN ledger_balance_pivot.bucket = 'advance' THEN ledger_balance_pivot.balance_sum ELSE 0::numeric END) AS pivot_advance
  FROM ledger_balance_pivot
  GROUP BY ledger_balance_pivot.user_id
)
SELECT wp.user_id,
  COALESCE((v.j ->> 'withdrawable_raw')::numeric, 0::numeric) AS cache_withdrawable,
  COALESCE(p.pivot_withdrawable, 0::numeric) AS pivot_withdrawable,
  COALESCE((v.j ->> 'withdrawable_raw')::numeric, 0::numeric) - COALESCE(p.pivot_withdrawable, 0::numeric) AS withdrawable_drift,
  COALESCE((v.j ->> 'float_raw')::numeric, 0::numeric) AS cache_float,
  COALESCE(p.pivot_float, 0::numeric) AS pivot_float,
  COALESCE((v.j ->> 'float_raw')::numeric, 0::numeric) - COALESCE(p.pivot_float, 0::numeric) AS float_drift,
  COALESCE((v.j ->> 'advance_raw')::numeric, 0::numeric) AS cache_advance,
  COALESCE(p.pivot_advance, 0::numeric) AS pivot_advance,
  COALESCE((v.j ->> 'advance_raw')::numeric, 0::numeric) - COALESCE(p.pivot_advance, 0::numeric) AS advance_drift
FROM wallets_physical wp
LEFT JOIN LATERAL public.get_user_wallet_view(wp.user_id) v(j) ON true
LEFT JOIN p ON p.user_id = wp.user_id;

-- 4) Recompute the pivot table for every wallet from the authoritative engine so
--    existing balances line up immediately (honoring all CFO retractions).
INSERT INTO public.ledger_balance_pivot (user_id, bucket, balance_sum, last_updated_at)
SELECT wp.user_id, b.bucket,
  CASE b.bucket
    WHEN 'withdrawable' THEN COALESCE((v.j ->> 'withdrawable_raw')::numeric, 0)
    WHEN 'float'        THEN COALESCE((v.j ->> 'float_raw')::numeric, 0)
    WHEN 'advance'      THEN COALESCE((v.j ->> 'advance_raw')::numeric, 0)
  END,
  now()
FROM public.wallets_physical wp
CROSS JOIN (VALUES ('withdrawable'),('float'),('advance')) AS b(bucket)
LEFT JOIN LATERAL public.get_user_wallet_view(wp.user_id) v(j) ON true
ON CONFLICT (user_id, bucket) DO UPDATE
  SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();