ALTER TABLE public.general_ledger
  ADD COLUMN IF NOT EXISTS recipient_type text,
  ADD COLUMN IF NOT EXISTS wallet_bucket text,
  ADD COLUMN IF NOT EXISTS routing_source text;

DO $$
BEGIN
  ALTER TABLE public.general_ledger
    ADD CONSTRAINT general_ledger_recipient_type_valid
    CHECK (recipient_type IS NULL OR recipient_type IN ('user', 'operational_wallet'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.general_ledger
    ADD CONSTRAINT general_ledger_wallet_bucket_valid
    CHECK (wallet_bucket IS NULL OR wallet_bucket IN ('withdrawable', 'float', 'advance_credit', 'advance_repayment'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_general_ledger_user_wallet_bucket
  ON public.general_ledger (user_id, wallet_bucket)
  WHERE ledger_scope = 'wallet' AND wallet_bucket IS NOT NULL;

COMMENT ON COLUMN public.general_ledger.recipient_type IS
  'Wallet Routing v2 intent: user routes to withdrawable; operational_wallet routes to float.';
COMMENT ON COLUMN public.general_ledger.wallet_bucket IS
  'Explicit wallet bucket override for this ledger leg. When set, wallet views honor it before category routing.';
COMMENT ON COLUMN public.general_ledger.routing_source IS
  'Audit note describing which code path or repair assigned the explicit wallet bucket.';

CREATE OR REPLACE FUNCTION public.create_ledger_transaction(
  entries jsonb,
  idempotency_key text DEFAULT NULL::text,
  skip_balance_check boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id uuid;
  v_entry jsonb;
  v_total_in numeric := 0;
  v_total_out numeric := 0;
  v_user_balance numeric;
  v_cached_withdrawable numeric;
  v_anchor_at timestamptz;
  v_lock_key bigint;
  v_wallet_id uuid;
BEGIN
  IF entries IS NULL OR jsonb_typeof(entries) <> 'array' THEN
    RAISE EXCEPTION 'entries must be a JSON array, got: %', COALESCE(jsonb_typeof(entries), 'NULL');
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);

  IF idempotency_key IS NOT NULL AND idempotency_key <> '' THEN
    v_lock_key := abs(hashtext(idempotency_key));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT transaction_group_id INTO v_group_id
    FROM public.general_ledger
    WHERE general_ledger.idempotency_key = create_ledger_transaction.idempotency_key
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_group_id IS NOT NULL THEN
      RETURN v_group_id;
    END IF;
  END IF;

  v_group_id := gen_random_uuid();

  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    IF (v_entry->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'All amounts must be positive, got: %', v_entry->>'amount';
    END IF;

    IF v_entry->>'direction' = 'cash_in' THEN
      v_total_in := v_total_in + (v_entry->>'amount')::numeric;
    ELSIF v_entry->>'direction' = 'cash_out' THEN
      v_total_out := v_total_out + (v_entry->>'amount')::numeric;

      IF NOT skip_balance_check
         AND COALESCE(v_entry->>'ledger_scope', 'wallet') = 'wallet'
         AND (v_entry->>'user_id') IS NOT NULL
         AND COALESCE(v_entry->>'wallet_bucket', 'withdrawable') = 'withdrawable' THEN

        SELECT anchor_at INTO v_anchor_at
        FROM public.wallet_fresh_start_anchors
        WHERE user_id = (v_entry->>'user_id')::uuid;

        WITH category_routed AS (
          SELECT COALESCE(SUM(CASE WHEN r.bucket = 'withdrawable' THEN r.sign * gl.amount ELSE 0 END), 0) AS net
          FROM public.general_ledger gl
          CROSS JOIN LATERAL public.wallet_route_for_category(gl.user_id, gl.category, gl.direction) r
          WHERE gl.user_id = (v_entry->>'user_id')::uuid
            AND gl.ledger_scope = 'wallet'
            AND (gl.classification IS NULL OR gl.classification = 'production')
            AND (v_anchor_at IS NULL OR gl.created_at >= v_anchor_at)
            AND gl.wallet_bucket IS NULL
        ), explicit_routed AS (
          SELECT COALESCE(SUM(
            CASE
              WHEN wallet_bucket = 'withdrawable' AND direction IN ('cash_in','credit') THEN amount
              WHEN wallet_bucket = 'withdrawable' AND direction IN ('cash_out','debit') THEN -amount
              ELSE 0
            END
          ), 0) AS net
          FROM public.general_ledger
          WHERE user_id = (v_entry->>'user_id')::uuid
            AND ledger_scope = 'wallet'
            AND (classification IS NULL OR classification = 'production')
            AND (v_anchor_at IS NULL OR created_at >= v_anchor_at)
            AND wallet_bucket IS NOT NULL
        )
        SELECT category_routed.net + explicit_routed.net
        INTO v_user_balance
        FROM category_routed, explicit_routed;

        SELECT COALESCE(withdrawable_balance, 0)
        INTO v_cached_withdrawable
        FROM public.wallets
        WHERE user_id = (v_entry->>'user_id')::uuid;

        v_user_balance := GREATEST(0,
          LEAST(COALESCE(v_cached_withdrawable, 0), GREATEST(0, COALESCE(v_user_balance, 0)))
        );

        IF v_user_balance < (v_entry->>'amount')::numeric THEN
          RAISE EXCEPTION 'Insufficient ledger balance for user %. Available: %, Required: %',
            v_entry->>'user_id', v_user_balance, v_entry->>'amount';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'Invalid direction: %. Must be cash_in or cash_out', v_entry->>'direction';
    END IF;
  END LOOP;

  IF v_total_in <> v_total_out THEN
    RAISE EXCEPTION 'Transaction not balanced. Total cash_in (%) <> total cash_out (%)', v_total_in, v_total_out;
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    v_wallet_id := NULL;
    IF (v_entry->>'user_id') IS NOT NULL THEN
      SELECT id INTO v_wallet_id
      FROM public.wallets
      WHERE user_id = (v_entry->>'user_id')::uuid;
    END IF;

    INSERT INTO public.general_ledger (
      user_id, wallet_id, ledger_scope, direction, category, amount, currency,
      description, source_table, source_id, transaction_group_id,
      idempotency_key, transaction_date, linked_party, reference_id, account,
      classification, recipient_type, wallet_bucket, routing_source
    ) VALUES (
      (v_entry->>'user_id')::uuid,
      v_wallet_id,
      COALESCE(v_entry->>'ledger_scope', 'wallet'),
      v_entry->>'direction',
      v_entry->>'category',
      (v_entry->>'amount')::numeric,
      COALESCE(v_entry->>'currency', 'UGX'),
      v_entry->>'description',
      COALESCE(v_entry->>'source_table', 'ledger_transaction'),
      (v_entry->>'source_id')::uuid,
      v_group_id,
      create_ledger_transaction.idempotency_key,
      COALESCE((v_entry->>'transaction_date')::timestamptz, now()),
      v_entry->>'linked_party',
      v_entry->>'reference_id',
      v_entry->>'account',
      COALESCE(v_entry->>'classification', 'production'),
      NULLIF(v_entry->>'recipient_type', ''),
      NULLIF(v_entry->>'wallet_bucket', ''),
      NULLIF(v_entry->>'routing_source', '')
    );
  END LOOP;

  RETURN v_group_id;
END;
$function$;

CREATE OR REPLACE VIEW public.v_user_wallet_strict AS
WITH anchors AS (
  SELECT user_id, anchor_at FROM public.wallet_fresh_start_anchors
),
ledger AS (
  SELECT gl.user_id, gl.category, gl.direction, gl.amount, gl.wallet_bucket
  FROM public.general_ledger gl
  LEFT JOIN anchors a ON a.user_id = gl.user_id
  WHERE gl.ledger_scope = 'wallet'
    AND (gl.classification IS NULL OR gl.classification = 'production')
    AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
    AND NOT (
      COALESCE(gl.classification, '') = 'admin_correction'
      AND COALESCE(gl.category, '') = 'system_balance_correction'
    )
),
routed_explicit AS (
  SELECT
    user_id,
    amount,
    wallet_bucket AS bucket,
    CASE
      WHEN direction IN ('cash_in','credit') THEN 1
      WHEN direction IN ('cash_out','debit') THEN -1
      ELSE 0
    END AS sign
  FROM ledger
  WHERE wallet_bucket IN ('withdrawable', 'float', 'advance_credit', 'advance_repayment')
),
routed_category AS (
  SELECT l.user_id, l.amount, r.bucket, r.sign
  FROM ledger l
  CROSS JOIN LATERAL public.wallet_route_for_category(l.user_id, l.category, l.direction) r
  WHERE l.wallet_bucket IS NULL
),
routed AS (
  SELECT * FROM routed_explicit
  UNION ALL
  SELECT * FROM routed_category
),
buckets AS (
  SELECT
    user_id,
    SUM(CASE WHEN bucket = 'withdrawable' THEN sign * amount ELSE 0 END) AS withdrawable_raw,
    SUM(CASE WHEN bucket = 'float'        THEN sign * amount ELSE 0 END) AS float_raw,
    SUM(CASE WHEN bucket IN ('advance_credit','advance_repayment')
             THEN sign * amount ELSE 0 END) AS advance_raw
  FROM routed
  GROUP BY user_id
),
holds AS (
  SELECT user_id, COALESCE(SUM(amount), 0) AS pending_holds
  FROM public.withdrawal_requests
  WHERE status = ANY (ARRAY['pending','requested','manager_approved','processing'])
  GROUP BY user_id
),
universe AS (
  SELECT user_id FROM public.wallets_physical
  UNION SELECT user_id FROM buckets
  UNION SELECT user_id FROM holds
)
SELECT
  u.user_id,
  GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(h.pending_holds, 0)) AS withdrawable,
  GREATEST(0, COALESCE(b.float_raw, 0)) AS float_balance,
  GREATEST(0, COALESCE(b.advance_raw, 0)) AS advance_balance,
  COALESCE(h.pending_holds, 0) AS pending_holds,
  GREATEST(0, COALESCE(b.withdrawable_raw, 0) - COALESCE(h.pending_holds, 0))
    + GREATEST(0, COALESCE(b.float_raw, 0)) AS total_visible
FROM universe u
LEFT JOIN buckets b ON b.user_id = u.user_id
LEFT JOIN holds h ON h.user_id = u.user_id;

ALTER VIEW public.v_user_wallet_strict SET (security_invoker = on);
GRANT SELECT ON public.v_user_wallet_strict TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_recipient_routing(
  p_user_id uuid,
  p_amount numeric,
  p_recipient_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_is_staff boolean;
  v_target_bucket text;
BEGIN
  v_caller := auth.uid();

  IF v_caller IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = v_caller
        AND role IN ('manager','cfo','super_admin','cto')
        AND COALESCE(enabled, true) = true
    ) INTO v_is_staff;
    IF NOT v_is_staff THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
  END IF;

  IF p_recipient_type IS NULL OR p_recipient_type NOT IN ('user','operational_wallet') THEN
    RAISE EXCEPTION 'RECIPIENT_TYPE_REQUIRED';
  END IF;

  v_target_bucket := CASE WHEN p_recipient_type = 'operational_wallet' THEN 'float' ELSE 'withdrawable' END;

  RETURN jsonb_build_object(
    'moved', 0,
    'reason', 'ledger_wallet_bucket_is_authoritative',
    'target_bucket', v_target_bucket,
    'user_id', p_user_id,
    'amount', COALESCE(p_amount, 0)
  );
END;
$function$;

-- Immutable repair: post a balanced compensating transaction instead of editing old ledger rows.
SELECT public.create_ledger_transaction(
  jsonb_build_array(
    jsonb_build_object(
      'user_id', '9bb21b14-cf97-428d-960a-abdd244e80b8',
      'amount', 353000,
      'direction', 'cash_out',
      'category', 'system_balance_correction',
      'ledger_scope', 'wallet',
      'source_table', 'wallet_route_repair',
      'reference_id', 'ROUTE-REPAIR-MUWANGUZI-20260512',
      'description', 'Route repair: remove misrouted wallet_deposit from withdrawable',
      'currency', 'UGX',
      'recipient_type', 'user',
      'wallet_bucket', 'withdrawable',
      'routing_source', 'immutable_route_repair_withdrawable_debit',
      'transaction_date', now()
    ),
    jsonb_build_object(
      'user_id', '9bb21b14-cf97-428d-960a-abdd244e80b8',
      'amount', 353000,
      'direction', 'cash_in',
      'category', 'agent_float_deposit',
      'ledger_scope', 'wallet',
      'source_table', 'wallet_route_repair',
      'reference_id', 'ROUTE-REPAIR-MUWANGUZI-20260512',
      'description', 'Route repair: restore operational float after wrong-bucket reversal',
      'currency', 'UGX',
      'recipient_type', 'operational_wallet',
      'wallet_bucket', 'float',
      'routing_source', 'immutable_route_repair_float_credit',
      'transaction_date', now()
    ),
    jsonb_build_object(
      'user_id', NULL,
      'amount', 353000,
      'direction', 'cash_in',
      'category', 'system_balance_correction',
      'ledger_scope', 'platform',
      'source_table', 'wallet_route_repair',
      'reference_id', 'ROUTE-REPAIR-MUWANGUZI-20260512',
      'description', 'Route repair balancing leg: withdrawable debit',
      'currency', 'UGX',
      'transaction_date', now()
    ),
    jsonb_build_object(
      'user_id', NULL,
      'amount', 353000,
      'direction', 'cash_out',
      'category', 'agent_float_deposit',
      'ledger_scope', 'platform',
      'source_table', 'wallet_route_repair',
      'reference_id', 'ROUTE-REPAIR-MUWANGUZI-20260512',
      'description', 'Route repair balancing leg: float restoration',
      'currency', 'UGX',
      'transaction_date', now()
    )
  ),
  'wallet-route-repair-muwanguzi-20260512',
  true
);

DO $$
DECLARE
  v_view jsonb;
  v_withdrawable numeric;
  v_float numeric;
BEGIN
  SELECT public.get_user_wallet_view('9bb21b14-cf97-428d-960a-abdd244e80b8'::uuid)
  INTO v_view;

  v_withdrawable := COALESCE((v_view->>'withdrawable')::numeric, 0);
  v_float := COALESCE((v_view->>'float_balance')::numeric, 0);

  IF v_withdrawable <> 96300 THEN
    RAISE EXCEPTION 'Muwanguzi Fred withdrawable repair failed: got %, expected 96300', v_withdrawable;
  END IF;

  IF v_float <> 187800 THEN
    RAISE EXCEPTION 'Muwanguzi Fred float repair failed: got %, expected 187800', v_float;
  END IF;
END $$;