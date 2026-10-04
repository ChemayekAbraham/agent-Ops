
-- 1. Pivot trigger: recompute from strict-view formula instead of incrementing.
CREATE OR REPLACE FUNCTION public.tg_ledger_pivot_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_anchor_at timestamptz;
  v_w numeric := 0;
  v_f numeric := 0;
  v_a numeric := 0;
BEGIN
  IF NEW.user_id IS NULL OR COALESCE(NEW.ledger_scope,'wallet') <> 'wallet' THEN
    RETURN NEW;
  END IF;

  SELECT anchor_at INTO v_anchor_at
    FROM public.wallet_fresh_start_anchors
   WHERE user_id = NEW.user_id
   LIMIT 1;

  -- Recompute the user's three buckets from ledger truth using the same
  -- routing rules as v_user_wallet_strict. This guarantees pivot ≡ strict view.
  WITH ledger AS (
    SELECT gl.category, gl.direction, gl.amount
    FROM public.general_ledger gl
    WHERE gl.user_id = NEW.user_id
      AND gl.ledger_scope = 'wallet'
      AND (gl.classification IS NULL OR gl.classification = 'production')
      AND (v_anchor_at IS NULL OR gl.created_at >= v_anchor_at)
      AND NOT (
        COALESCE(gl.classification,'') = 'admin_correction'
        AND COALESCE(gl.category,'') = 'system_balance_correction'
      )
  ),
  routed AS (
    SELECT l.amount, r.bucket, r.sign
    FROM ledger l
    CROSS JOIN LATERAL public.wallet_route_for_category(NEW.user_id, l.category, l.direction) r(bucket, sign)
  )
  SELECT
    COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN sign::numeric * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket = 'float' THEN sign::numeric * amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN bucket IN ('advance_credit','advance_repayment') THEN sign::numeric * amount ELSE 0 END), 0)
  INTO v_w, v_f, v_a
  FROM routed;

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

-- 2. One-time recompute of existing pivot rows from strict-view truth.
DO $$
DECLARE
  r record;
  v_anchor_at timestamptz;
  v_w numeric;
  v_f numeric;
  v_a numeric;
BEGIN
  FOR r IN SELECT DISTINCT user_id FROM public.ledger_balance_pivot LOOP
    SELECT anchor_at INTO v_anchor_at
      FROM public.wallet_fresh_start_anchors WHERE user_id = r.user_id LIMIT 1;

    WITH ledger AS (
      SELECT gl.category, gl.direction, gl.amount
      FROM public.general_ledger gl
      WHERE gl.user_id = r.user_id
        AND gl.ledger_scope = 'wallet'
        AND (gl.classification IS NULL OR gl.classification = 'production')
        AND (v_anchor_at IS NULL OR gl.created_at >= v_anchor_at)
        AND NOT (
          COALESCE(gl.classification,'') = 'admin_correction'
          AND COALESCE(gl.category,'') = 'system_balance_correction'
        )
    ),
    routed AS (
      SELECT l.amount, rt.bucket, rt.sign
      FROM ledger l
      CROSS JOIN LATERAL public.wallet_route_for_category(r.user_id, l.category, l.direction) rt(bucket, sign)
    )
    SELECT
      COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN sign::numeric * amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN bucket = 'float' THEN sign::numeric * amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN bucket IN ('advance_credit','advance_repayment') THEN sign::numeric * amount ELSE 0 END), 0)
    INTO v_w, v_f, v_a
    FROM routed;

    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (r.user_id, 'withdrawable', COALESCE(v_w,0), now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (r.user_id, 'float', COALESCE(v_f,0), now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (r.user_id, 'advance', COALESCE(v_a,0), now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();
  END LOOP;
END$$;

-- 3. Backstop BEFORE INSERT trigger: assert routing resolves before any wallet-scope row is written.
CREATE OR REPLACE FUNCTION public.assert_wallet_routing()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_route record;
BEGIN
  IF COALESCE(NEW.ledger_scope,'wallet') <> 'wallet' THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN RETURN NEW; END IF;

  -- Skip historical/admin partitions; production rule only.
  IF COALESCE(NEW.classification,'production') <> 'production' THEN RETURN NEW; END IF;

  BEGIN
    SELECT * INTO v_route
    FROM public.wallet_route_for_category(NEW.user_id, NEW.category, NEW.direction);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'WALLET_ROUTING_REQUIRED: cannot route ledger row (category=%, direction=%): %',
      NEW.category, NEW.direction, SQLERRM
      USING ERRCODE = 'check_violation';
  END;

  IF v_route.bucket IS NULL OR v_route.bucket = 'none' OR COALESCE(v_route.sign,0) = 0 THEN
    RAISE EXCEPTION 'WALLET_ROUTING_REQUIRED: empty route for category=%, direction=%',
      NEW.category, NEW.direction
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_assert_wallet_routing ON public.general_ledger;
CREATE TRIGGER trg_assert_wallet_routing
  BEFORE INSERT ON public.general_ledger
  FOR EACH ROW EXECUTE FUNCTION public.assert_wallet_routing();

-- 4. Diagnostic view: pivot vs strict-view drift.
CREATE OR REPLACE VIEW public.v_pivot_drift AS
WITH p AS (
  SELECT
    user_id,
    COALESCE(SUM(CASE WHEN bucket = 'withdrawable' THEN balance_sum END), 0) AS pivot_withdrawable,
    COALESCE(SUM(CASE WHEN bucket = 'float' THEN balance_sum END), 0) AS pivot_float,
    COALESCE(SUM(CASE WHEN bucket = 'advance' THEN balance_sum END), 0) AS pivot_advance
  FROM public.ledger_balance_pivot
  GROUP BY user_id
)
SELECT
  COALESCE(p.user_id, s.user_id) AS user_id,
  p.pivot_withdrawable,
  s.withdrawable AS strict_withdrawable,
  COALESCE(p.pivot_withdrawable,0) - COALESCE(s.withdrawable,0) AS withdrawable_delta,
  p.pivot_float,
  s.float_balance AS strict_float,
  COALESCE(p.pivot_float,0) - COALESCE(s.float_balance,0) AS float_delta,
  p.pivot_advance,
  s.advance_balance AS strict_advance,
  COALESCE(p.pivot_advance,0) - COALESCE(s.advance_balance,0) AS advance_delta
FROM p
FULL OUTER JOIN public.v_user_wallet_strict s ON s.user_id = p.user_id
WHERE
     ABS(COALESCE(p.pivot_withdrawable,0) - COALESCE(s.withdrawable,0)) > 0.005
  OR ABS(COALESCE(p.pivot_float,0) - COALESCE(s.float_balance,0)) > 0.005
  OR ABS(COALESCE(p.pivot_advance,0) - COALESCE(s.advance_balance,0)) > 0.005;

GRANT SELECT ON public.v_pivot_drift TO authenticated;
