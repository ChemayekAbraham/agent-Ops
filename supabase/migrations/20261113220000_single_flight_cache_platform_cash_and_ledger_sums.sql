-- Single-flight cache for the two ledger scans that OOM-killed Postgres
-- (8GB) at 14:50 EAT on 2026-11-11: about 40 overlapping calls from one
-- client retry storm.
--
--   public.get_platform_cash_summary()
--     live md5(pg_get_functiondef) c07c0ea77d2b82b345211dffdf1d187b
--   public.get_financial_statement_ledger_sums(timestamptz, timestamptz)
--     live md5(pg_get_functiondef) c8cd9bfd9baed8c6a0e3647e0fca5e5e
--
-- The heavy helper is NOT replaced. It keeps its body, signature, STABLE
-- marker, security, search_path, statement_timeout and grants:
--   public.get_financial_statement_ledger_sums__impl(timestamptz, timestamptz)
--     live md5(pg_get_functiondef) 97596d88f6910f1b0c29e8222f9115ed
--
-- Why this is not a straight copy of the latest CREATE OR REPLACE in
-- supabase/migrations (by filename):
--   * 20260412161252 is the latest create of get_platform_cash_summary.
--     Production has since added platform_fee_collected to total_revenue,
--     the advisor staff check, and statement_timeout = 120s
--     (drizzle/migrations/0135). Replacing with the file would drop fee
--     revenue and the authorisation check.
--   * 20260815112622 is the latest create of get_financial_statement_ledger_sums.
--     20261018280000 renamed that SQL body to __impl and put a staff-checked
--     plpgsql wrapper in front. Production's __impl also includes
--     admin_correction rows whose source_table is merchant_float_reconciliations.
--     This migration calls that helper and does not rewrite it.
--
-- The migration refuses to run if any of those three live definitions has
-- moved, so a later edit cannot be overwritten by this file.
--
-- Cache: one row per function name + md5(arguments), reused for 30 seconds.
-- pg_try_advisory_xact_lock(hashtext(key)) lets one backend compute. The
-- others take pg_advisory_xact_lock (blocking, released at commit, so the
-- wait is inside the existing 120s statement_timeout) and then read the row
-- the computer committed. At most one computation of a given argument set
-- runs at a time.
--
-- get_financial_statement_ledger_sums was STABLE. PostgREST runs STABLE
-- functions in a read-only transaction, which cannot insert the cache row,
-- so the wrapper is VOLATILE. Return type, security, search_path,
-- statement_timeout, grants and the staff check are unchanged. The helper
-- stays STABLE.
--
-- The cache holds staff financial aggregates, not a ledger. RLS is on and
-- there are no policies. anon, authenticated and service_role have no
-- privileges (service_role bypasses RLS, so a grant would expose the table).
-- Only these SECURITY DEFINER functions, running as postgres (bypassrls),
-- read and write it. Rows older than a day are deleted on the compute path.

DO $guard$
DECLARE
  v_cash text;
  v_sums text;
  v_impl text;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_cash
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'get_platform_cash_summary'
    AND pg_get_function_identity_arguments(p.oid) = '';

  SELECT md5(pg_get_functiondef(p.oid)) INTO v_sums
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'get_financial_statement_ledger_sums'
    AND pg_get_function_identity_arguments(p.oid) = 'p_start timestamp with time zone, p_end timestamp with time zone';

  SELECT md5(pg_get_functiondef(p.oid)) INTO v_impl
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'get_financial_statement_ledger_sums__impl'
    AND pg_get_function_identity_arguments(p.oid) = 'p_start timestamp with time zone, p_end timestamp with time zone';

  IF v_cash IS DISTINCT FROM 'c07c0ea77d2b82b345211dffdf1d187b' THEN
    RAISE EXCEPTION 'refusing to replace get_platform_cash_summary: live md5 % does not match c07c0ea77d2b82b345211dffdf1d187b', coalesce(v_cash, 'missing');
  END IF;
  IF v_sums IS DISTINCT FROM 'c8cd9bfd9baed8c6a0e3647e0fca5e5e' THEN
    RAISE EXCEPTION 'refusing to replace get_financial_statement_ledger_sums: live md5 % does not match c8cd9bfd9baed8c6a0e3647e0fca5e5e', coalesce(v_sums, 'missing');
  END IF;
  IF v_impl IS DISTINCT FROM '97596d88f6910f1b0c29e8222f9115ed' THEN
    RAISE EXCEPTION 'get_financial_statement_ledger_sums__impl changed (md5 %); this migration calls it unchanged and will not replace it', coalesce(v_impl, 'missing');
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.rpc_result_cache (
  key text PRIMARY KEY,
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL
);

COMMENT ON TABLE public.rpc_result_cache IS
  'Thirty-second results for heavy read-only RPCs. Not a financial record. No API access; SECURITY DEFINER functions write it.';

ALTER TABLE public.rpc_result_cache ENABLE ROW LEVEL SECURITY;

-- No policies. With RLS on, anon and authenticated see nothing even if a
-- grant is added later. postgres (the function owner) bypasses RLS.
REVOKE ALL ON TABLE public.rpc_result_cache FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_platform_cash_summary()
 RETURNS json
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  result JSON;
  wallet_result JSON;
  v_key text;
  v_payload jsonb;
  v_hit boolean := false;
  v_locked boolean;
BEGIN
  -- Same staff check as the live function (advisor pass, 2026-10-18).
  /* advisor_guard */ if not (pg_trigger_depth() > 0 or public.can_view_staff_reports(auth.uid())) then raise exception 'not authorized' using errcode = '42501'; end if;

  v_key := 'get_platform_cash_summary:' || md5(''::text);

  SELECT c.payload INTO v_payload
  FROM public.rpc_result_cache c
  WHERE c.key = v_key
    AND c.computed_at > clock_timestamp() - interval '30 seconds';
  IF FOUND THEN
    v_hit := true;
  ELSE
    v_locked := pg_try_advisory_xact_lock(hashtext(v_key));
    IF v_locked THEN
      -- The previous computer may have committed between the miss and this lock.
      SELECT c.payload INTO v_payload
      FROM public.rpc_result_cache c
      WHERE c.key = v_key
        AND c.computed_at > clock_timestamp() - interval '30 seconds';
      IF FOUND THEN
        v_hit := true;
      END IF;
    ELSE
      -- Another backend is computing this key. Wait until it commits
      -- (the lock is transactional), bounded by statement_timeout above.
      PERFORM pg_advisory_xact_lock(hashtext(v_key));
      SELECT c.payload INTO v_payload
      FROM public.rpc_result_cache c
      WHERE c.key = v_key
        AND c.computed_at > clock_timestamp() - interval '30 seconds';
      IF FOUND THEN
        v_hit := true;
      END IF;
    END IF;
  END IF;

  IF v_hit THEN
    RETURN v_payload::json;
  END IF;

  -- Platform scope: revenue, costs, and recoveries.
  -- Category list is the live body, including platform_fee_collected.
  SELECT json_build_object(
    'total_revenue', COALESCE(SUM(CASE
      WHEN direction = 'cash_in' AND category IN (
        'tenant_access_fee','access_fee','tenant_request_fee','request_fee',
        'platform_service_income','landlord_platform_fee','management_fee',
        'access_fee_collected','registration_fee_collected','platform_fee_collected',
        'wallet_deduction'
      )
      THEN amount ELSE 0 END), 0),
    'total_costs', COALESCE(SUM(CASE
      WHEN direction = 'cash_out' AND category IN (
        'supporter_platform_rewards','supporter_reward','investment_reward',
        'roi_payout','roi_expense',
        'agent_commission_payout','agent_commission','agent_payout',
        'agent_approval_bonus','referral_bonus','agent_commission_earned',
        'transaction_platform_expenses','operational_expenses','platform_expense',
        'system_balance_correction','wallet_deduction'
      )
      THEN amount ELSE 0 END), 0),
    'platform_cash_in', COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE 0 END), 0),
    'platform_cash_out', COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE 0 END), 0)
  ) INTO result
  FROM general_ledger
  WHERE ledger_scope = 'platform'
    AND classification IN ('production','legacy_real')
    AND category != 'opening_balance';

  -- Wallet/bridge scope totals
  SELECT json_build_object(
    'wallet_cash_in', COALESCE(SUM(CASE WHEN direction = 'cash_in' THEN amount ELSE 0 END), 0),
    'wallet_cash_out', COALESCE(SUM(CASE WHEN direction = 'cash_out' THEN amount ELSE 0 END), 0)
  ) INTO wallet_result
  FROM general_ledger
  WHERE ledger_scope IN ('wallet','bridge')
    AND classification IN ('production','legacy_real');

  result := json_build_object(
    'total_revenue', (result->>'total_revenue')::numeric,
    'total_costs', (result->>'total_costs')::numeric,
    'platform_cash_in', (result->>'platform_cash_in')::numeric,
    'platform_cash_out', (result->>'platform_cash_out')::numeric,
    'wallet_cash_in', (wallet_result->>'wallet_cash_in')::numeric,
    'wallet_cash_out', (wallet_result->>'wallet_cash_out')::numeric
  );

  INSERT INTO public.rpc_result_cache (key, payload, computed_at)
  VALUES (v_key, result::jsonb, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET payload = EXCLUDED.payload,
        computed_at = EXCLUDED.computed_at;

  DELETE FROM public.rpc_result_cache
  WHERE computed_at < clock_timestamp() - interval '1 day';

  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_platform_cash_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_platform_cash_summary() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_financial_statement_ledger_sums(
  p_start timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_end timestamp with time zone DEFAULT NULL::timestamp with time zone
)
 RETURNS TABLE(period text, ledger_scope text, direction text, category text, desc_bucket text, amount numeric)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_key text;
  v_payload jsonb;
  v_hit boolean := false;
  v_locked boolean;
BEGIN
  -- Same staff check as the live wrapper. The scan stays in __impl.
  /* advisor_guard */ if not (pg_trigger_depth() > 0 or public.can_view_staff_reports(auth.uid())) then raise exception 'not authorized' using errcode = '42501'; end if;

  v_key := 'get_financial_statement_ledger_sums:' || md5(jsonb_build_array(p_start, p_end)::text);

  SELECT c.payload INTO v_payload
  FROM public.rpc_result_cache c
  WHERE c.key = v_key
    AND c.computed_at > clock_timestamp() - interval '30 seconds';
  IF FOUND THEN
    v_hit := true;
  ELSE
    v_locked := pg_try_advisory_xact_lock(hashtext(v_key));
    IF v_locked THEN
      SELECT c.payload INTO v_payload
      FROM public.rpc_result_cache c
      WHERE c.key = v_key
        AND c.computed_at > clock_timestamp() - interval '30 seconds';
      IF FOUND THEN
        v_hit := true;
      END IF;
    ELSE
      PERFORM pg_advisory_xact_lock(hashtext(v_key));
      SELECT c.payload INTO v_payload
      FROM public.rpc_result_cache c
      WHERE c.key = v_key
        AND c.computed_at > clock_timestamp() - interval '30 seconds';
      IF FOUND THEN
        v_hit := true;
      END IF;
    END IF;
  END IF;

  IF NOT v_hit THEN
    SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) INTO v_payload
    FROM public.get_financial_statement_ledger_sums__impl(p_start, p_end) AS s;

    INSERT INTO public.rpc_result_cache (key, payload, computed_at)
    VALUES (v_key, v_payload, clock_timestamp())
    ON CONFLICT (key) DO UPDATE
      SET payload = EXCLUDED.payload,
          computed_at = EXCLUDED.computed_at;

    DELETE FROM public.rpc_result_cache
    WHERE computed_at < clock_timestamp() - interval '1 day';
  END IF;

  RETURN QUERY
  SELECT r.period, r.ledger_scope, r.direction, r.category, r.desc_bucket, r.amount
  FROM jsonb_to_recordset(v_payload) AS r(
    period text,
    ledger_scope text,
    direction text,
    category text,
    desc_bucket text,
    amount numeric
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_financial_statement_ledger_sums(timestamp with time zone, timestamp with time zone) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_financial_statement_ledger_sums(timestamp with time zone, timestamp with time zone) TO authenticated, service_role;
