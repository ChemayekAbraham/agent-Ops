CREATE OR REPLACE FUNCTION public.create_ledger_transaction(entries jsonb, idempotency_key text DEFAULT NULL::text, skip_balance_check boolean DEFAULT false)
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
  v_recipient_type text;
  v_category text;
  v_scope text;
  v_effective_bucket text;
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

    v_category       := v_entry->>'category';
    v_scope          := COALESCE(v_entry->>'ledger_scope', 'wallet');
    v_recipient_type := NULLIF(v_entry->>'recipient_type', '');

    IF v_scope = 'wallet' AND v_category IN (
      'agent_repayment','agent_advance_repayment','salary_advance_repayment','debt_recovery'
    ) THEN
      IF v_recipient_type IS NULL THEN
        BEGIN
          INSERT INTO public.wallet_routing_violations (
            user_id, category, direction, amount, recipient_type, reason, context
          ) VALUES (
            NULLIF(v_entry->>'user_id','')::uuid,
            v_category, v_entry->>'direction',
            (v_entry->>'amount')::numeric, NULL,
            'RECIPIENT_TYPE_REQUIRED',
            jsonb_build_object('source','create_ledger_transaction','rule','advance_recovery_isolation')
          );
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        RAISE EXCEPTION 'agent_repayment requires explicit recipient_type on the wallet leg' USING ERRCODE = 'check_violation';
      END IF;

      BEGIN
        PERFORM public.assert_routing_compatible(v_category, v_recipient_type);
      EXCEPTION WHEN check_violation THEN
        BEGIN
          INSERT INTO public.wallet_routing_violations (
            user_id, category, direction, amount, recipient_type, reason, context
          ) VALUES (
            NULLIF(v_entry->>'user_id','')::uuid,
            v_category, v_entry->>'direction',
            (v_entry->>'amount')::numeric, v_recipient_type,
            SQLERRM,
            jsonb_build_object('source','create_ledger_transaction','rule','advance_recovery_isolation')
          );
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        RAISE;
      END;
    END IF;

    IF v_entry->>'direction' = 'cash_in' THEN
      v_total_in := v_total_in + (v_entry->>'amount')::numeric;
    ELSIF v_entry->>'direction' = 'cash_out' THEN
      v_total_out := v_total_out + (v_entry->>'amount')::numeric;

      -- Resolve the effective wallet bucket the way the BEFORE INSERT trigger
      -- (trg_set_wallet_bucket_from_recipient_type) will: an explicit
      -- wallet_bucket wins, otherwise recipient_type decides
      -- (operational_wallet -> float, user -> withdrawable). Without this,
      -- float legs that rely on recipient_type were defaulting to
      -- 'withdrawable' and getting wrongly gated against the agent's tiny
      -- withdrawable balance instead of their float.
      v_effective_bucket := COALESCE(
        NULLIF(v_entry->>'wallet_bucket', ''),
        CASE
          WHEN v_recipient_type = 'operational_wallet' THEN 'float'
          WHEN v_recipient_type = 'user' THEN 'withdrawable'
          ELSE 'withdrawable'
        END
      );

      IF NOT skip_balance_check
         AND v_scope = 'wallet'
         AND (v_entry->>'user_id') IS NOT NULL
         AND v_effective_bucket = 'withdrawable' THEN

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
      classification, recipient_type, wallet_bucket, routing_source,
      solvency_bypass_reason
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
      NULLIF(v_entry->>'routing_source', ''),
      NULLIF(v_entry->>'solvency_bypass_reason', '')::public.solvency_bypass_reason
    );
  END LOOP;

  RETURN v_group_id;
END;
$function$;