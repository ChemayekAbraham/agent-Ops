-- Verbatim production copies (12 Nov 2026, read-only export via pg_get_functiondef, project byrzshwlentqvktcksem) of the
-- wallet-debit code that Special Advances Pay from Wallet (20261118090000) runs through. Test fixture only.
--   md5(prosrc) where recorded:
--   public.create_ledger_transaction(jsonb,text,boolean)  8e570ba579b151ac17788c0ee668a93b
--   public.enforce_no_negative_wallet_ledger()  5b84f2e9f2793debdd631351094793bf
--   public.get_user_available_balance__impl(uuid)  f66debb067f286f8e055ea286f15a815
--   public.get_advance_locked_withdrawable(uuid)

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
  v_headers jsonb;
  v_req_ip text;
  v_req_ua text;
BEGIN
  IF entries IS NULL OR jsonb_typeof(entries) <> 'array' THEN
    RAISE EXCEPTION 'entries must be a JSON array, got: %', COALESCE(jsonb_typeof(entries), 'NULL');
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);

  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
    v_req_ua := v_headers ->> 'user-agent';
    IF v_req_ua IS NOT NULL AND v_req_ua ILIKE '%SupabaseEdgeRuntime%' THEN
      v_req_ip := NULL;
      v_req_ua := NULL;
    ELSE
      v_req_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      IF v_req_ip IS NULL THEN
        v_req_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_req_ip := NULL;
    v_req_ua := NULL;
  END;

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
      solvency_bypass_reason, ip_address, user_agent
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
      NULLIF(v_entry->>'solvency_bypass_reason', '')::public.solvency_bypass_reason,
      v_req_ip,
      v_req_ua
    );
  END LOOP;

  RETURN v_group_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_no_negative_wallet_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_available numeric := 0;
  v_float numeric := 0;
  v_current_hold numeric := 0;
  v_effective_bucket text := 'withdrawable';
  v_is_admin_bypass boolean := false;
  v_is_writeoff_bypass boolean := false;
BEGIN
  IF NEW.ledger_scope IS DISTINCT FROM 'wallet' THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.direction NOT IN ('cash_out', 'debit') THEN
    RETURN NEW;
  END IF;

  v_is_admin_bypass := COALESCE(NEW.classification, '') = 'admin_correction';
  v_is_writeoff_bypass := COALESCE(NEW.category, '') = 'platform_loss_writeoff';

  IF v_is_admin_bypass OR v_is_writeoff_bypass THEN
    IF NEW.solvency_bypass_reason IS NULL THEN
      RAISE EXCEPTION
        'SOLVENCY_BYPASS_REASON_REQUIRED: cash_out leg classified % / category % must include a solvency_bypass_reason code',
        COALESCE(NEW.classification, '(null)'), COALESCE(NEW.category, '(null)')
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.solvency_bypass_reason = 'other_with_note'
       AND length(COALESCE(NEW.description, '')) < 30 THEN
      RAISE EXCEPTION
        'SOLVENCY_BYPASS_NOTE_REQUIRED: reason code other_with_note requires a description of at least 30 characters'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.category, '') = 'system_balance_correction' THEN
    RETURN NEW;
  END IF;

  v_effective_bucket := COALESCE(
    NULLIF(NEW.wallet_bucket, ''),
    CASE
      WHEN NEW.recipient_type = 'operational_wallet' THEN 'float'
      WHEN NEW.recipient_type = 'user' THEN 'withdrawable'
      ELSE NULL
    END,
    (
      SELECT r.bucket
      FROM public.wallet_route_for_category(NEW.user_id, NEW.category, NEW.direction) r
      LIMIT 1
    ),
    'withdrawable'
  );

  IF v_effective_bucket = 'float'
     OR COALESCE(NEW.recipient_type, '') = 'operational_wallet' THEN
    SELECT float_balance INTO v_float
    FROM public.wallet_balances_projection
    WHERE user_id = NEW.user_id;

    IF v_float IS NULL THEN
      SELECT COALESCE(float_balance, 0) INTO v_float
      FROM public.wallet_strict_for_user(NEW.user_id);
    END IF;

    IF COALESCE(v_float, 0) < NEW.amount THEN
      RAISE EXCEPTION 'NEGATIVE_FLOAT_BLOCKED: user % cannot debit % from float (ledger-backed float balance is %)',
        NEW.user_id, NEW.amount, COALESCE(v_float, 0)
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_table = 'withdrawal_requests' AND NEW.source_id IS NOT NULL THEN
    SELECT COALESCE(wr.amount, 0)
      INTO v_current_hold
    FROM public.withdrawal_requests wr
    WHERE wr.id = NEW.source_id
      AND wr.status IN ('pending', 'requested', 'manager_approved', 'processing', 'approved')
      AND (wr.reason IS NULL OR wr.reason NOT LIKE 'Landlord float payout%')
      AND (
        CASE
          WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
          ELSE wr.user_id
        END
      ) = NEW.user_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.general_ledger g
        WHERE g.source_table = 'withdrawal_requests'
          AND g.source_id = wr.id
          AND g.ledger_scope = 'wallet'
          AND g.direction IN ('cash_out', 'debit')
      )
    LIMIT 1;
  END IF;

  -- Portfolio funding debits: a pending funder reservation for THIS portfolio is
  -- what the debit is settling, so it must not block its own settlement. Every
  -- other pending commitment stays held. Mirrors the withdrawal allowance above.
  IF NEW.source_table = 'investor_portfolios' AND NEW.source_id IS NOT NULL THEN
    SELECT COALESCE(fpp.amount, 0)
      INTO v_current_hold
    FROM public.funder_pending_portfolios fpp
    WHERE fpp.portfolio_id = NEW.source_id
      AND fpp.funder_id = NEW.user_id
      AND fpp.status = 'pending'
      AND NOT EXISTS (
        SELECT 1
        FROM public.general_ledger g
        WHERE g.source_table = 'investor_portfolios'
          AND g.source_id = fpp.portfolio_id
          AND g.ledger_scope = 'wallet'
          AND g.direction IN ('cash_out', 'debit')
      )
    LIMIT 1;
  END IF;

  -- Advance-reversal clawbacks recover the very funds that the
  -- `advance_withdrawals_paused` treasury control locks, so they must be
  -- measured against the reversal-scoped balance (locked advance funds
  -- included). Everything else keeps the strict withdrawable gate.
  -- Bike-lease cancellations recover the same locked agent_advance_credit. They are
  -- recognised by shape (create_ledger_transaction does not persist sub_category): the leg
  -- must reference 'bike-lease-cancel-<sale_id>' for that same sale, and that sale must be an
  -- approved lease owned by this wallet owner, so a made-up reference cannot lift the lock.
  IF COALESCE(NEW.sub_category, '') LIKE 'advance_reversal:%'
     OR (NEW.category = 'agent_advance_credit'
         AND NEW.source_table = 'merchandise_sales'
         AND NEW.source_id IS NOT NULL
         AND NEW.reference_id = 'bike-lease-cancel-' || NEW.source_id::text
         AND EXISTS (SELECT 1 FROM public.agent_bike_leases bl
                     WHERE bl.sale_id = NEW.source_id
                       AND bl.agent_id = NEW.user_id
                       AND bl.status = 'approved'))
     OR (NEW.category = 'agent_repayment'
         AND NEW.source_table = 'merchandise_recovery_plans'
         AND EXISTS (SELECT 1 FROM public.merchandise_recovery_plans mp
                     WHERE mp.id = NEW.source_id AND mp.phone_collection_enabled
                       AND NOT COALESCE(mp.is_bike_lease, false))) THEN
    v_available := COALESCE(public.get_user_advance_reversal_available(NEW.user_id), 0)
                   + COALESCE(v_current_hold, 0);
  ELSE
    v_available := COALESCE(public.get_user_available_balance(NEW.user_id), 0) + COALESCE(v_current_hold, 0);
  END IF;

  IF v_available < NEW.amount THEN
    RAISE EXCEPTION 'LEDGER_BACKING_REQUIRED: user % cannot debit % from withdrawable funds (ledger-backed available is %)',
      NEW.user_id, NEW.amount, v_available
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_user_available_balance__impl(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
  SELECT GREATEST(
    0::numeric,
    COALESCE((
      SELECT withdrawable FROM public.wallet_balances_projection WHERE user_id = p_user_id
    ), 0::numeric)
    - public.funder_pending_hold(p_user_id)
    - CASE
        WHEN COALESCE((
          SELECT enabled FROM public.treasury_controls
          WHERE control_key = 'advance_withdrawals_paused'
        ), false)
        THEN public.get_advance_locked_withdrawable(p_user_id)
        ELSE 0::numeric
      END
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_advance_locked_withdrawable(p_user_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH credits AS (
    SELECT COALESCE(SUM(amount), 0)::numeric AS total,
           MIN(transaction_date) AS first_at
    FROM public.general_ledger
    WHERE user_id = p_user_id
      AND ledger_scope = 'wallet'
      AND direction = 'cash_in'
      AND category = 'agent_advance_credit'
      AND COALESCE(wallet_bucket, 'withdrawable') = 'withdrawable'
      AND COALESCE(classification, 'production') <> 'admin_correction'
  ),
  outflows AS (
    SELECT COALESCE(SUM(g.amount), 0)::numeric AS total
    FROM public.general_ledger g, credits c
    WHERE g.user_id = p_user_id
      AND g.ledger_scope = 'wallet'
      AND g.direction = 'cash_out'
      AND c.first_at IS NOT NULL
      AND g.transaction_date >= c.first_at
      AND COALESCE(g.classification, 'production') <> 'admin_correction'
      AND g.category <> 'system_balance_correction'
  )
  SELECT GREATEST(0::numeric, (SELECT total FROM credits) - (SELECT total FROM outflows));
$function$;
