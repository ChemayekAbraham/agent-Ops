-- Speed up _wallet_strict_for_users_impl by routing each null wallet bucket once per key.
--
-- wallet_route_for_category(uuid, text, text) is plpgsql STABLE. It probes
-- user_roles on every call, so the planner cannot inline it. The live body
-- calls it from routed_category once per general_ledger row whose
-- wallet_bucket is null.
--
-- Read-only on byrzshwlentqvktcksem, 2026-10-27, before this file:
-- 158,857 wallet rows have a null bucket, and those rows have 5,066 distinct
-- (user_id, category, direction) keys. The nine rows with a null key all have
-- a null user_id. The ledger filter is user_id = ANY (p_ids), so they never
-- reach routing. A null direction raises UNSUPPORTED_LEDGER_DIRECTION. A null
-- category fails validate_ledger_category and raises. The equality join
-- therefore sees the same keys as the per-row call, and STABLE means one call
-- per key in this statement returns the same bucket and sign.
--
-- EXPLAIN (ANALYZE) of this body for every user_roles.role = 'agent'
-- (59,555 ids): Function Scan on wallet_route_for_category loops=2,553,
-- execution 2,385 ms.
--
-- Compared with the live function by CTAS into temp tables (dropped in the
-- same session; no permanent DDL), same 59,555 ids:
--   run 1: 8,563 ms -> 2,857 ms, 59,555 rows
--   run 2: 14,665 ms -> 4,425 ms, 59,555 rows
-- EXCEPT and EXCEPT ALL were 0 rows in both directions on both runs.
-- Run 2 was slower on both sides while other sessions were active.
--
-- Signature, RETURNS TABLE column order, LANGUAGE sql, STABLE, SECURITY DEFINER
-- and search_path stay as they are. CREATE OR REPLACE keeps the current ACL
-- (EXECUTE for postgres and service_role). The statements below re-state that
-- closed set. Refuses to replace the function unless prosrc md5 is still the
-- body measured above. Does not change v_user_wallet_strict, anchors, or the
-- ledger filter. Not applied to production by this change.
-- Version 20261029000300 sorts after 20261029000200.

SET lock_timeout = '5s';

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  IF to_regprocedure('public._wallet_strict_for_users_impl(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public._wallet_strict_for_users_impl(uuid[]) does not exist';
  END IF;
  SELECT md5(prosrc) INTO v_md5
  FROM pg_proc
  WHERE oid = 'public._wallet_strict_for_users_impl(uuid[])'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'ae5df256bad0e926f59da8d89c1f14d2' THEN
    RAISE EXCEPTION 'precondition failed: _wallet_strict_for_users_impl prosrc md5 is %, expected ae5df256bad0e926f59da8d89c1f14d2', v_md5;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public._wallet_strict_for_users_impl(p_ids uuid[])
RETURNS TABLE (
  user_id uuid,
  withdrawable numeric,
  float_balance numeric,
  advance_balance numeric,
  pending_holds numeric,
  restricted_held numeric,
  total_visible numeric,
  float_balance_signed numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
 WITH anchors AS (
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
                  WHERE gl.user_id = ANY (p_ids) AND gl.ledger_scope = 'wallet'::text AND (gl.classification IS NULL OR gl.classification = 'production'::text OR gl.classification = 'admin_correction'::text AND gl.category = 'system_balance_correction'::text AND (gl.direction = ANY (ARRAY['debit'::text, 'cash_out'::text])) OR gl.classification = 'admin_correction'::text AND gl.category = 'system_balance_correction'::text AND (gl.direction = ANY (ARRAY['credit'::text, 'cash_in'::text])) AND gl.source_table = 'fin_s14b1r_lines'::text AND gl.idempotency_key ~~ 'batch1\_restore:s14b1:%'::text AND (EXISTS ( SELECT 1
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
                 SELECT DISTINCT ledger.user_id, ledger.category, ledger.direction
                   FROM ledger
                  WHERE ledger.wallet_bucket IS NULL
                ), route_map AS MATERIALIZED (
                 SELECT k.user_id, k.category, k.direction, r.bucket, r.sign
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
                     JOIN route_map m ON m.user_id = l.user_id AND m.category = l.category AND m.direction = l.direction
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
                  WHERE (wr.user_id = ANY (p_ids) OR wr.agent_id = ANY (p_ids)) AND (wr.status = ANY (ARRAY['pending'::text, 'requested'::text, 'manager_approved'::text, 'processing'::text, 'approved'::text])) AND NOT (EXISTS ( SELECT 1
                           FROM general_ledger g
                          WHERE g.source_table = 'withdrawal_requests'::text AND g.source_id = wr.id AND g.ledger_scope = 'wallet'::text AND (g.direction = ANY (ARRAY['cash_out'::text, 'debit'::text])))) AND (wr.reason IS NULL OR wr.reason !~~ 'Landlord float payout%'::text)
                  GROUP BY (
                        CASE
                            WHEN wr.proxy_partner_id IS NOT NULL AND wr.agent_id IS NOT NULL THEN wr.agent_id
                            ELSE wr.user_id
                        END)
                ), universe AS (
                 SELECT wallets_physical.user_id
                   FROM wallets_physical WHERE wallets_physical.user_id = ANY (p_ids)
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
             LEFT JOIN holds h ON h.user_id = u.user_id WHERE u.user_id = ANY (p_ids) 

$function$;

REVOKE ALL ON FUNCTION public._wallet_strict_for_users_impl(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._wallet_strict_for_users_impl(uuid[]) TO service_role;
