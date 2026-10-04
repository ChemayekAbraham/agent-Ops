
-- 1) Replace pivot trigger function with anchor + classification filters
CREATE OR REPLACE FUNCTION public.tg_ledger_pivot_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_route record;
  v_signed numeric;
  v_anchor_at timestamptz;
BEGIN
  IF NEW.user_id IS NULL OR COALESCE(NEW.ledger_scope,'wallet') <> 'wallet' THEN
    RETURN NEW;
  END IF;
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
    RETURN NEW;
  END IF;

  -- Mirror user-facing filter: drop legacy_real / test_dev, and the admin_correction+system_balance_correction pair
  IF COALESCE(NEW.classification,'') IN ('legacy_real','test_dev') THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.classification,'') = 'admin_correction'
     AND COALESCE(NEW.category,'') = 'system_balance_correction' THEN
    RETURN NEW;
  END IF;

  -- Honor fresh-start anchor: ignore rows created before the anchor
  SELECT anchor_at INTO v_anchor_at
    FROM public.wallet_fresh_start_anchors
   WHERE user_id = NEW.user_id
   LIMIT 1;
  IF v_anchor_at IS NOT NULL AND COALESCE(NEW.created_at, NEW.transaction_date) < v_anchor_at THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT * INTO v_route FROM public.wallet_route_for_category(NEW.user_id, NEW.category, NEW.direction);
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.wallet_unrouted_movements (user_id, category, direction, amount, bucket_returned, sign_returned)
      VALUES (NEW.user_id, NEW.category, NEW.direction, NEW.amount, 'pivot_unrouted', 0);
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN NEW;
  END;

  v_signed := NEW.amount * v_route.sign;

  IF v_route.bucket = 'withdrawable' THEN
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (NEW.user_id, 'withdrawable', v_signed, now())
      ON CONFLICT (user_id, bucket)
      DO UPDATE SET balance_sum = p.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();

  ELSIF v_route.bucket = 'float' THEN
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (NEW.user_id, 'float', v_signed, now())
      ON CONFLICT (user_id, bucket)
      DO UPDATE SET balance_sum = p.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();

  ELSIF v_route.bucket = 'advance_credit' THEN
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (NEW.user_id, 'withdrawable', NEW.amount, now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = p.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (NEW.user_id, 'advance', NEW.amount, now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = p.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();

  ELSIF v_route.bucket = 'advance_repayment' THEN
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (NEW.user_id, 'withdrawable', -NEW.amount, now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = p.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();
    INSERT INTO public.ledger_balance_pivot AS p (user_id, bucket, balance_sum, last_updated_at)
      VALUES (NEW.user_id, 'advance', -NEW.amount, now())
      ON CONFLICT (user_id, bucket) DO UPDATE SET balance_sum = p.balance_sum + EXCLUDED.balance_sum, last_updated_at = now();
  END IF;

  RETURN NEW;
END;
$function$;

-- 2) Rebuild pivot from filtered ledger (full re-seed)
TRUNCATE public.ledger_balance_pivot;

WITH src AS (
  SELECT gl.user_id, gl.category, gl.direction, gl.amount, gl.created_at, gl.transaction_date
    FROM public.general_ledger gl
    LEFT JOIN public.wallet_fresh_start_anchors a ON a.user_id = gl.user_id
   WHERE gl.user_id IS NOT NULL
     AND COALESCE(gl.ledger_scope,'wallet') = 'wallet'
     AND gl.amount IS NOT NULL AND gl.amount > 0
     AND COALESCE(gl.classification,'') NOT IN ('legacy_real','test_dev')
     AND NOT (COALESCE(gl.classification,'') = 'admin_correction'
              AND COALESCE(gl.category,'') = 'system_balance_correction')
     AND (a.anchor_at IS NULL OR COALESCE(gl.created_at, gl.transaction_date) >= a.anchor_at)
),
routed AS (
  SELECT s.user_id, s.amount,
         (public.wallet_route_for_category(s.user_id, s.category, s.direction)).bucket AS bucket,
         (public.wallet_route_for_category(s.user_id, s.category, s.direction)).sign   AS sign
    FROM src s
),
expanded AS (
  -- withdrawable
  SELECT user_id, 'withdrawable'::text AS bucket, SUM(amount * sign)::numeric AS balance_sum
    FROM routed WHERE bucket = 'withdrawable' GROUP BY user_id
  UNION ALL
  -- float
  SELECT user_id, 'float', SUM(amount * sign) FROM routed WHERE bucket = 'float' GROUP BY user_id
  UNION ALL
  -- advance_credit -> +withdrawable, +advance
  SELECT user_id, 'withdrawable', SUM(amount) FROM routed WHERE bucket = 'advance_credit' GROUP BY user_id
  UNION ALL
  SELECT user_id, 'advance',      SUM(amount) FROM routed WHERE bucket = 'advance_credit' GROUP BY user_id
  UNION ALL
  -- advance_repayment -> -withdrawable, -advance
  SELECT user_id, 'withdrawable', -SUM(amount) FROM routed WHERE bucket = 'advance_repayment' GROUP BY user_id
  UNION ALL
  SELECT user_id, 'advance',      -SUM(amount) FROM routed WHERE bucket = 'advance_repayment' GROUP BY user_id
)
INSERT INTO public.ledger_balance_pivot (user_id, bucket, balance_sum, last_updated_at)
SELECT user_id, bucket, SUM(balance_sum), now()
  FROM expanded
 WHERE user_id IS NOT NULL
 GROUP BY user_id, bucket
ON CONFLICT (user_id, bucket) DO UPDATE
   SET balance_sum = EXCLUDED.balance_sum, last_updated_at = now();
