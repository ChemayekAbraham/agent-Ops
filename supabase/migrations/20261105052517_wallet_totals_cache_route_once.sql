-- refresh_wallet_totals_cache runs every few minutes and was spending ~26s in
-- v_user_wallet_strict. routed_category called the STABLE plpgsql function
-- wallet_route_for_category once per null-bucket ledger leg, and the cache
-- function scanned that view twice.
--
-- The view now routes each distinct (user_id, category, direction) once
-- (the same shape as _wallet_strict_for_users_impl) and joins the map back
-- with COALESCE equality. Plain = drops a NULL user_id row. IS NOT DISTINCT
-- FROM stops the hash join and the planner times out. COALESCE of category
-- and direction folds NULL together with '', which is not present on the
-- null-bucket wallet keys this was measured against.
--
-- The function reads the view once (strict AS MATERIALIZED) and replaces the
-- per-wallet LATERAL with one GROUP BY user_id over general_ledger. The
-- upsert into wallet_totals_cache is unchanged. This file does not call the
-- function, because that writes the cache. Not applied to production here.
--
-- Read-only on byrzshwlentqvktcksem, 2026-11-04, REPEATABLE READ, work_mem 64MB.
-- The function was not called. EXPLAIN (ANALYZE, BUFFERS) of the two reads
-- inlined, then of the single new statement with this view body inlined:
--   before: execution 20871.089 ms, wallet_route_for_category loops 139008+139008
--   after:  execution 3336.538 ms, wallet_route_for_category loops 2837
-- View EXCEPT ALL was 0 both ways, 98333 rows each. The eight cache figures
-- matched (total_wallets 98331, active 1164, total_balance 113541161.71,
-- total_float 45204390, total_withdrawable 68336771.71, strict_total
-- 71269528.71, drifted_wallets 1140, total_drift 0).
--
-- Live before this file: viewdef md5 0b40ee82a398af783881756515a883f2
-- (pg_get_viewdef pretty), function prosrc md5 b4c143ce9c06bfa64cbde1e737e67a00.
-- View relacl {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres},
-- reloptions null. Function proacl {postgres=X/postgres,service_role=X/postgres},
-- SECURITY DEFINER, search_path public, statement_timeout 300000, work_mem 64MB.
-- Version 20261104150000 sorts after 20261104120100.

SET lock_timeout = '5s';

DO $pre_view$
DECLARE
  v_md5 text;
BEGIN
  IF to_regclass('public.v_user_wallet_strict') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.v_user_wallet_strict does not exist';
  END IF;
  SELECT md5(pg_get_viewdef('public.v_user_wallet_strict'::regclass, true)) INTO v_md5;
  IF v_md5 IS DISTINCT FROM '0b40ee82a398af783881756515a883f2' THEN
    RAISE EXCEPTION 'precondition failed: v_user_wallet_strict viewdef md5 is %, expected 0b40ee82a398af783881756515a883f2', v_md5;
  END IF;
END
$pre_view$;

CREATE OR REPLACE VIEW public.v_user_wallet_strict AS
 SELECT user_id,
    withdrawable,
    float_balance,
    advance_balance,
    pending_holds,
    restricted_held,
    total_visible,
    float_balance_signed
   FROM ( WITH anchors AS (
                 SELECT wallet_fresh_start_anchors.user_id,
                    wallet_fresh_start_anchors.anchor_at
                   FROM wallet_fresh_start_anchors
                ), ledger AS (
                 SELECT gl.user_id,
                    gl.category,
                    gl.direction,
                    gl.amount,
                    gl.wallet_bucket,
                    gl.maturity_met,
                    gl.maturity_expired,
                    gl.withdrawable_after
                   FROM general_ledger gl
                     LEFT JOIN anchors a ON a.user_id = gl.user_id
                  WHERE gl.ledger_scope = 'wallet'::text AND (gl.classification IS NULL OR gl.classification = 'production'::text OR gl.classification = 'admin_correction'::text AND gl.category = 'system_balance_correction'::text AND (gl.direction = ANY (ARRAY['debit'::text, 'cash_out'::text])) OR gl.classification = 'admin_correction'::text AND gl.category = 'system_balance_correction'::text AND (gl.direction = ANY (ARRAY['credit'::text, 'cash_in'::text])) AND gl.source_table = 'fin_s14b1r_lines'::text AND gl.idempotency_key ~~ 'batch1\_restore:s14b1:%'::text AND (EXISTS ( SELECT 1
                           FROM fin_s14b1r_lines l
                          WHERE ('batch1_restore:'::text || l.orig_idempotency_key) = gl.idempotency_key AND l.ledger_scope = 'wallet'::text AND l.user_id = gl.user_id AND l.amount = gl.amount)) OR gl.classification = 'admin_correction'::text AND gl.category = 'merchant_float_correction_writedown'::text AND (gl.direction = ANY (ARRAY['debit'::text, 'cash_out'::text]))) AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at) AND NOT (gl.source_table = 'commission_engine'::text AND (EXISTS ( SELECT 1
                           FROM commission_accrual_ledger cal
                          WHERE cal.agent_id = gl.user_id AND cal.event_type = 'rent_funded_landlord_float'::text AND cal.status = 'reversed'::text AND cal.source_id = gl.source_id::text))) AND NOT (gl.source_table = 'commission_engine_reversal'::text AND gl.classification = 'admin_correction'::text AND gl.category = 'system_balance_correction'::text AND gl.amount = 10000::numeric AND (EXISTS ( SELECT 1
                           FROM commission_accrual_ledger cal
                          WHERE cal.agent_id = gl.user_id AND cal.event_type = 'rent_funded_landlord_float'::text AND cal.status = 'reversed'::text)))
                ), routed_explicit AS (
                 SELECT ledger.user_id,
                    ledger.amount,
                    ledger.wallet_bucket AS bucket,
                        CASE
                            WHEN ledger.direction = ANY (ARRAY['cash_in'::text, 'credit'::text]) THEN 1
                            WHEN ledger.direction = ANY (ARRAY['cash_out'::text, 'debit'::text]) THEN '-1'::integer
                            ELSE 0
                        END AS sign,
                    ledger.maturity_met,
                    ledger.maturity_expired,
                    ledger.withdrawable_after,
                    ledger.direction,
                    ledger.category
                   FROM ledger
                  WHERE ledger.wallet_bucket = ANY (ARRAY['withdrawable'::text, 'float'::text, 'advance_credit'::text, 'advance_repayment'::text])
                ), routed_keys AS (
                 SELECT DISTINCT ledger.user_id,
                    ledger.category,
                    ledger.direction
                   FROM ledger
                  WHERE ledger.wallet_bucket IS NULL
                ), route_map AS MATERIALIZED (
                 SELECT k.user_id,
                    k.category,
                    k.direction,
                    r.bucket,
                    r.sign
                   FROM routed_keys k
                     CROSS JOIN LATERAL wallet_route_for_category(k.user_id, k.category, k.direction) r(bucket, sign)
                ), routed_category AS (
                 SELECT l.user_id,
                    l.amount,
                    m.bucket,
                    m.sign,
                    l.maturity_met,
                    l.maturity_expired,
                    l.withdrawable_after,
                    l.direction,
                    l.category
                   FROM ledger l
                     JOIN route_map m ON COALESCE(m.user_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(l.user_id, '00000000-0000-0000-0000-000000000000'::uuid) AND COALESCE(m.category, '') = COALESCE(l.category, '') AND COALESCE(m.direction, '') = COALESCE(l.direction, '')
                  WHERE l.wallet_bucket IS NULL
                ), routed AS (
                 SELECT routed_explicit.user_id,
                    routed_explicit.amount,
                    routed_explicit.bucket,
                    routed_explicit.sign,
                    routed_explicit.maturity_met,
                    routed_explicit.maturity_expired,
                    routed_explicit.withdrawable_after,
                    routed_explicit.direction,
                    routed_explicit.category
                   FROM routed_explicit
                UNION ALL
                 SELECT routed_category.user_id,
                    routed_category.amount,
                    routed_category.bucket,
                    routed_category.sign,
                    routed_category.maturity_met,
                    routed_category.maturity_expired,
                    routed_category.withdrawable_after,
                    routed_category.direction,
                    routed_category.category
                   FROM routed_category
                ), buckets AS (
                 SELECT routed.user_id,
                    sum(
                        CASE
                            WHEN routed.bucket = 'withdrawable'::text THEN routed.sign::numeric * routed.amount
                            ELSE 0::numeric
                        END) AS withdrawable_raw,
                    sum(
                        CASE
                            WHEN routed.bucket = 'float'::text THEN routed.sign::numeric * routed.amount
                            ELSE 0::numeric
                        END) AS float_raw,
                    sum(
                        CASE
                            WHEN routed.bucket = ANY (ARRAY['advance_credit'::text, 'advance_repayment'::text]) THEN routed.sign::numeric * routed.amount
                            ELSE 0::numeric
                        END) AS advance_raw,
                    sum(
                        CASE
                            WHEN routed.bucket = 'withdrawable'::text AND (routed.direction = ANY (ARRAY['cash_in'::text, 'credit'::text])) AND (routed.maturity_expired = true OR routed.maturity_met = false AND now() <= COALESCE(routed.withdrawable_after, now())) THEN routed.amount
                            ELSE 0::numeric
                        END) AS restricted_held
                   FROM routed
                  GROUP BY routed.user_id
                ), holds AS (
                 SELECT
                        CASE
                            WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
                            ELSE wr.user_id
                        END AS user_id,
                    COALESCE(sum(wr.amount), 0::numeric) AS pending_holds
                   FROM withdrawal_requests wr
                  WHERE (wr.status = ANY (ARRAY['pending'::text, 'requested'::text, 'manager_approved'::text, 'processing'::text, 'approved'::text])) AND NOT (EXISTS ( SELECT 1
                           FROM general_ledger g
                          WHERE g.source_table = 'withdrawal_requests'::text AND g.source_id = wr.id AND g.ledger_scope = 'wallet'::text AND (g.direction = ANY (ARRAY['cash_out'::text, 'debit'::text])))) AND (wr.reason IS NULL OR wr.reason !~~ 'Landlord float payout%'::text)
                  GROUP BY (
                        CASE
                            WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
                            ELSE wr.user_id
                        END)
                ), universe AS (
                 SELECT wallets_physical.user_id
                   FROM wallets_physical
                UNION
                 SELECT buckets.user_id
                   FROM buckets
                UNION
                 SELECT holds.user_id
                   FROM holds
                )
         SELECT u.user_id,
            GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(b.restricted_held, 0::numeric) - COALESCE(h.pending_holds, 0::numeric)) AS withdrawable,
            GREATEST(0::numeric, COALESCE(b.float_raw, 0::numeric)) AS float_balance,
            GREATEST(0::numeric, COALESCE(b.advance_raw, 0::numeric)) AS advance_balance,
            COALESCE(h.pending_holds, 0::numeric) AS pending_holds,
            COALESCE(b.restricted_held, 0::numeric) AS restricted_held,
            GREATEST(0::numeric, COALESCE(b.withdrawable_raw, 0::numeric) - COALESCE(b.restricted_held, 0::numeric) - COALESCE(h.pending_holds, 0::numeric)) + GREATEST(0::numeric, COALESCE(b.float_raw, 0::numeric)) AS total_visible,
            COALESCE(b.float_raw, 0::numeric) AS float_balance_signed
           FROM universe u
             LEFT JOIN buckets b ON b.user_id = u.user_id
             LEFT JOIN holds h ON h.user_id = u.user_id) q
  WHERE CURRENT_USER <> 'authenticated'::name OR (user_id IN ( SELECT agent_wallet_network_ids(auth.uid()) AS agent_wallet_network_ids)) OR ( SELECT can_view_staff_reports(auth.uid()) AS can_view_staff_reports);

REVOKE ALL ON TABLE public.v_user_wallet_strict FROM PUBLIC;
REVOKE ALL ON TABLE public.v_user_wallet_strict FROM anon, authenticated;
GRANT ALL ON TABLE public.v_user_wallet_strict TO postgres;
GRANT ALL ON TABLE public.v_user_wallet_strict TO service_role;

DO $pre_fn$
DECLARE
  v_md5 text;
BEGIN
  IF to_regprocedure('public.refresh_wallet_totals_cache()') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.refresh_wallet_totals_cache() does not exist';
  END IF;
  SELECT md5(prosrc) INTO v_md5
  FROM pg_proc
  WHERE oid = 'public.refresh_wallet_totals_cache()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'b4c143ce9c06bfa64cbde1e737e67a00' THEN
    RAISE EXCEPTION 'precondition failed: refresh_wallet_totals_cache prosrc md5 is %, expected b4c143ce9c06bfa64cbde1e737e67a00', v_md5;
  END IF;
END
$pre_fn$;

CREATE OR REPLACE FUNCTION public.refresh_wallet_totals_cache()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300000'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_total_wallets bigint;
  v_active_wallets bigint;
  v_total_balance numeric;
  v_total_float numeric;
  v_total_withdrawable numeric;
  v_strict_total numeric;
  v_drifted_wallets bigint;
  v_total_drift numeric;
BEGIN
  -- One scan of the strict view, reused for the headline and the drift join.
  -- The ledger target is one aggregate per user, not a lateral per wallet.
  WITH strict AS MATERIALIZED (
    SELECT user_id, total_visible, float_balance, withdrawable
    FROM public.v_user_wallet_strict
  ),
  tgt AS (
    SELECT
      gl.user_id,
      GREATEST(0, COALESCE(SUM(CASE
        WHEN COALESCE(gl.category, '') NOT IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
         AND COALESCE(gl.category, '') NOT LIKE 'advance_%'
        THEN CASE WHEN gl.direction = 'cash_in' THEN gl.amount WHEN gl.direction = 'cash_out' THEN -gl.amount ELSE 0 END
        ELSE 0 END), 0))::numeric AS target_withdrawable,
      GREATEST(0, COALESCE(SUM(CASE
        WHEN COALESCE(gl.category, '') IN ('agent_float_deposit','agent_float_used_for_rent','agent_float_settlement','agent_float_assignment','rent_float_funding','partner_funding')
        THEN CASE WHEN gl.direction = 'cash_in' THEN gl.amount WHEN gl.direction = 'cash_out' THEN -gl.amount ELSE 0 END
        ELSE 0 END), 0))::numeric AS target_float
    FROM public.general_ledger gl
    LEFT JOIN public.wallet_fresh_start_anchors a ON a.user_id = gl.user_id
    WHERE gl.ledger_scope = 'wallet'
      AND (gl.classification IS NULL OR gl.classification = 'production')
      AND COALESCE(gl.category, '') <> 'system_balance_correction'
      AND (a.anchor_at IS NULL OR gl.created_at >= a.anchor_at)
    GROUP BY gl.user_id
  ),
  h AS (
    SELECT
      COUNT(*) AS total_wallets,
      COUNT(*) FILTER (WHERE COALESCE(total_visible, 0) > 0) AS active_wallets,
      COALESCE(SUM(COALESCE(total_visible, 0)), 0) AS total_balance,
      COALESCE(SUM(COALESCE(float_balance, 0)), 0) AS total_float,
      COALESCE(SUM(COALESCE(withdrawable, 0)), 0) AS total_withdrawable
    FROM strict
    WHERE user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid
  ),
  d AS (
    SELECT
      COALESCE(SUM(COALESCE(s.total_visible, 0)::numeric), 0) AS strict_total,
      COUNT(*) FILTER (WHERE ABS(COALESCE(w.balance, 0)::numeric - (COALESCE(t.target_withdrawable, 0) + COALESCE(t.target_float, 0))::numeric) > 100) AS drifted_wallets,
      COALESCE(SUM(GREATEST(COALESCE(w.balance, 0)::numeric - (COALESCE(t.target_withdrawable, 0) + COALESCE(t.target_float, 0))::numeric, 0)), 0) AS total_drift
    FROM public.wallets w
    LEFT JOIN tgt t ON t.user_id = w.user_id
    LEFT JOIN strict s ON s.user_id = w.user_id
    WHERE w.user_id <> '06b14430-7cdc-41c9-96a4-a8dedf8995b1'::uuid
  )
  SELECT
    h.total_wallets,
    h.active_wallets,
    h.total_balance,
    h.total_float,
    h.total_withdrawable,
    d.strict_total,
    d.drifted_wallets,
    d.total_drift
  INTO
    v_total_wallets,
    v_active_wallets,
    v_total_balance,
    v_total_float,
    v_total_withdrawable,
    v_strict_total,
    v_drifted_wallets,
    v_total_drift
  FROM h
  CROSS JOIN d;

  INSERT INTO public.wallet_totals_cache AS c (
    id, total_wallets, active_wallets, total_balance, total_float, total_withdrawable,
    strict_total, drifted_wallets, total_drift, computed_at
  ) VALUES (
    1, v_total_wallets, v_active_wallets, v_total_balance, v_total_float, v_total_withdrawable,
    v_strict_total, v_drifted_wallets, v_total_drift, now()
  )
  ON CONFLICT (id) DO UPDATE SET
    total_wallets      = EXCLUDED.total_wallets,
    active_wallets     = EXCLUDED.active_wallets,
    total_balance      = EXCLUDED.total_balance,
    total_float        = EXCLUDED.total_float,
    total_withdrawable = EXCLUDED.total_withdrawable,
    strict_total       = EXCLUDED.strict_total,
    drifted_wallets    = EXCLUDED.drifted_wallets,
    total_drift        = EXCLUDED.total_drift,
    computed_at        = EXCLUDED.computed_at;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_wallet_totals_cache() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_wallet_totals_cache() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_wallet_totals_cache() TO postgres;
GRANT EXECUTE ON FUNCTION public.refresh_wallet_totals_cache() TO service_role;
