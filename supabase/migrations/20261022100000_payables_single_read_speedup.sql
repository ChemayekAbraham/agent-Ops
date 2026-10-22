-- 2026-10-22: payables screens load in about 1-2 s instead of timing out (8 s statement limit for signed-in users).
--
-- Measured read-only on production 2026-10-22: get_payables_total's query took 11.3 s, so the payables total card
-- failed for every signed-in user; v_payables_lines took about 1.4 s and the payables functions read it up to 14 times.
-- Three causes, three changes. Figures and rules are UNCHANGED: each new definition was run read-only against
-- production next to the live one and returned identical rows (EXCEPT ALL both ways = 0; same counts and totals).
--
--   1. v_landlord_payout_settlement (869 ms -> 316 ms). The "transaction ID used by another payout" count joined
--      xtid_use, which the planner estimated at 1 row (actual 2,559), so it ran a 1,489 x 2,559 nested loop. The count is
--      now looked up in one jsonb map built once (xtid_map). Same count, same rule.
--   2. v_landlord_float_payables (about 1.4 s -> 0.57 s). It built the settlement view twice (paid_rr, agg_pay); it now
--      reads it once (ls, MATERIALIZED).
--   3. get_payables_total, get_payables_breakdown, get_payables_contract_schedule, get_payables_due_range read
--      v_payables_lines once per call (l0, MATERIALIZED) instead of 5, 2, up to 14 and 5 times. A STABLE function's
--      statements all see one snapshot, so a single read returns exactly what the repeated reads did.
--
-- Not changed: get_payables_predictive_forecast (already single-read since supabase/pending/20261022000000), and
-- get_payables_forecast_accuracy, which runs the forecast once per backtest origin and is a separate fix.
--
-- REPORTING ONLY. No ledger entry, wallet, payout, withdrawal, receipt check or alert is written. CREATE OR REPLACE
-- keeps every grant: the views stay service_role-only, the functions stay callable by authenticated.
-- Rollback: supabase/rollbacks/20261022100000_payables_single_read_speedup.rollback.sql (restores the exact definitions replaced here).

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF md5(pg_get_viewdef('public.v_landlord_payout_settlement'::regclass)) <> '680b4ad33292166ab9cbba735b1d02bd'
     OR md5(pg_get_viewdef('public.v_landlord_float_payables'::regclass)) <> 'cbd0351144700d7340efd1460e4ff08a'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_payables_total()'::regprocedure) <> '0b719f4545484c9354961d328a62084c'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_payables_breakdown()'::regprocedure) <> '9ccce297bea10e279e91234cd3c4e086'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_payables_contract_schedule(text,integer,date)'::regprocedure) <> 'fbfe0961235207348c6bca448fe8f92b'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_payables_due_range(date,date)'::regprocedure) <> 'bf351cccd505167c3cdcaa909ea815e8' THEN
    RAISE EXCEPTION 'precondition failed: a payables view or function changed since 2026-10-22; nothing was changed. Regenerate this migration from the current definitions';
  END IF;
END
$pre$;

-- 1. Settlement: transaction-ID usage through one map, not a misestimated join.
CREATE OR REPLACE VIEW public.v_landlord_payout_settlement AS
WITH wr AS (
         SELECT DISTINCT ON (w.landlord_payout_id) w.landlord_payout_id,
            w.id AS withdrawal_id,
            w.processed_at,
            w.amount AS paid_amount,
            w.receipt_token,
            w.payout_proof_path,
            COALESCE(w.payout_proof_bucket, 'payment-proofs'::text) AS proof_bucket,
            w.payout_proof_uploaded_at,
            NULLIF(regexp_replace(COALESCE(NULLIF(w.transaction_id, ''::text), w.fin_ops_reference, ''::text), '[^0-9]'::text, ''::text, 'g'::text), ''::text) AS ref
           FROM withdrawal_requests w
          WHERE w.landlord_payout_id IS NOT NULL AND w.status = 'completed'::text
          ORDER BY w.landlord_payout_id, w.processed_at DESC NULLS LAST
        ), alloc AS (
         SELECT DISTINCT ON (a.rent_request_id) a.rent_request_id,
            a.week_start,
            a.weekly_budget_id,
            a.kind
           FROM landlord_float_budget_allocations a
          WHERE a.released_at IS NULL AND a.rent_request_id IS NOT NULL AND (EXISTS ( SELECT 1
                   FROM landlord_float_budgets b
                  WHERE b.period_type = 'weekly'::text AND b.superseded_at IS NULL AND b.period_start = a.week_start))
          ORDER BY a.rent_request_id, a.approved_at DESC NULLS LAST
        ), base AS (
         SELECT lp.id AS payout_id,
            lp.rent_request_id,
            lp.landlord_id,
            COALESCE(NULLIF(lp.landlord_name, ''::text), pr.full_name) AS landlord_name,
            lp.landlord_phone,
            lp.mobile_money_provider,
            lp.amount,
            lp.status AS payout_status,
            lp.created_at,
            wr.withdrawal_id,
            wr.ref AS ref_withdrawal,
            wr.paid_amount,
            wr.receipt_token,
            wr.payout_proof_path,
            wr.proof_bucket,
            wr.payout_proof_uploaded_at,
            NULLIF(regexp_replace(COALESCE(lp.finops_momo_reference, ''::text), '[^0-9]'::text, ''::text, 'g'::text), ''::text) AS ref_finops,
            wr.withdrawal_id IS NOT NULL OR NULLIF(regexp_replace(COALESCE(lp.finops_momo_reference, ''::text), '[^0-9]'::text, ''::text, 'g'::text), ''::text) IS NOT NULL AND lp.finops_disbursed_at IS NOT NULL AS paid_out,
            COALESCE(wr.processed_at, lp.finops_disbursed_at) AS paid_at,
                CASE
                    WHEN wr.processed_at IS NOT NULL THEN 'withdrawal_completed'::text
                    WHEN lp.finops_disbursed_at IS NOT NULL THEN 'finops_disbursed'::text
                    ELSE NULL::text
                END AS paid_date_source,
            al.week_start AS float_week_start,
            al.weekly_budget_id,
            al.kind AS allocation_kind
           FROM landlord_payouts lp
             LEFT JOIN wr ON wr.landlord_payout_id = lp.id
             LEFT JOIN alloc al ON al.rent_request_id = lp.rent_request_id
             LEFT JOIN profiles pr ON pr.id = lp.landlord_id
        ), ocr AS (
         SELECT DISTINCT ON (o.withdrawal_request_id, o.storage_path) o.withdrawal_request_id,
            o.storage_path,
            o.id AS check_id,
            o.created_at AS checked_at,
            o.validation_result,
            o.validation_code,
            NULLIF(regexp_replace(COALESCE(o.extracted_tid, ''::text), '[^0-9]'::text, ''::text, 'g'::text), ''::text) AS xtid,
            o.extracted_amount AS xamt,
            o.extracted_date AS xdate
           FROM payout_proof_ocr_log o
          ORDER BY o.withdrawal_request_id, o.storage_path, o.created_at DESC
        ), xtid_use AS (
         SELECT o.xtid,
            count(DISTINCT COALESCE(w.landlord_payout_id, w.id)) AS uses
           FROM withdrawal_requests w
             JOIN ocr o ON o.withdrawal_request_id = w.id AND o.storage_path = w.payout_proof_path
          WHERE w.status = 'completed'::text AND o.xtid IS NOT NULL
          GROUP BY o.xtid
        ), xtid_map AS (
         SELECT jsonb_object_agg(xtid_use.xtid, xtid_use.uses) AS m
           FROM xtid_use
        ), wref_use AS (
         SELECT x.ref,
            count(DISTINCT x.owner) AS uses
           FROM ( SELECT NULLIF(regexp_replace(COALESCE(NULLIF(w.transaction_id, ''::text), w.fin_ops_reference, ''::text), '[^0-9]'::text, ''::text, 'g'::text), ''::text) AS ref,
                    COALESCE(w.landlord_payout_id, w.id) AS owner
                   FROM withdrawal_requests w
                  WHERE w.status = 'completed'::text) x
          WHERE x.ref IS NOT NULL
          GROUP BY x.ref
        ), ref_all AS (
         SELECT x.ref,
            count(DISTINCT x.payout_id) AS payouts
           FROM ( SELECT base.payout_id,
                    base.ref_withdrawal AS ref
                   FROM base
                  WHERE base.ref_withdrawal IS NOT NULL
                UNION ALL
                 SELECT base.payout_id,
                    base.ref_finops
                   FROM base
                  WHERE base.ref_finops IS NOT NULL) x
          GROUP BY x.ref
        ), alerts AS (
         SELECT a.withdrawal_id,
            array_agg(DISTINCT a.issue_type ORDER BY a.issue_type) AS issue_types
           FROM payout_proof_integrity_alerts a
          WHERE NOT a.resolved AND a.withdrawal_id IS NOT NULL
          GROUP BY a.withdrawal_id
        ), lpr_current AS (
         SELECT q.payout_id,
            q.receipt_number,
            q.status,
            q.reversed_at,
            q.replaced,
            q.reversed
           FROM ( WITH RECURSIVE lpr_walk AS (
                         SELECT r_1.payout_id,
                            r_1.id AS receipt_id,
                            0 AS depth,
                            ARRAY[r_1.id] AS path
                           FROM landlord_payout_receipts r_1
                        UNION ALL
                         SELECT w_1.payout_id,
                            n.id,
                            w_1.depth + 1,
                            w_1.path || n.id
                           FROM lpr_walk w_1
                             JOIN landlord_payout_receipts n ON n.replaces_receipt_id = w_1.receipt_id
                          WHERE w_1.depth < 20 AND NOT (n.id = ANY (w_1.path))
                        )
                 SELECT DISTINCT ON (w.payout_id) w.payout_id,
                    r.receipt_number,
                    r.status,
                    r.reversed_at,
                    w.depth > 0 AS replaced,
                    r.reversed_at IS NOT NULL OR (r.status = ANY (ARRAY['reversed'::text, 'refunded'::text])) AS reversed
                   FROM lpr_walk w
                     JOIN landlord_payout_receipts r ON r.id = w.receipt_id
                  ORDER BY w.payout_id, w.depth DESC, r.created_at DESC) q
        ), rc0 AS (
         SELECT b.payout_id,
            b.rent_request_id,
            b.landlord_id,
            b.landlord_name,
            b.landlord_phone,
            b.mobile_money_provider,
            b.amount,
            b.payout_status,
            b.created_at,
            b.withdrawal_id,
            b.ref_withdrawal,
            b.paid_amount,
            b.receipt_token,
            b.payout_proof_path,
            b.proof_bucket,
            b.payout_proof_uploaded_at,
            b.ref_finops,
            b.paid_out,
            b.paid_at,
            b.paid_date_source,
            b.float_week_start,
            b.weekly_budget_id,
            b.allocation_kind,
            o.check_id,
            o.checked_at,
            o.validation_result,
            o.validation_code,
            o.xtid,
            o.xamt,
            o.xdate,
            b.receipt_token IS NOT NULL AND b.payout_proof_path IS NOT NULL AS has_receipt,
            b.payout_proof_path IS NOT NULL AND (EXISTS ( SELECT 1
                   FROM storage.objects so
                  WHERE so.bucket_id = b.proof_bucket AND so.name = b.payout_proof_path)) AS file_accessible,
            COALESCE((xm.m ->> o.xtid)::bigint, 0::bigint) AS xtid_uses,
            COALESCE(wu.uses, 0::bigint) AS ref_uses,
            COALESCE(ra.payouts, 0::bigint) AS ref_payouts,
            al.issue_types AS open_alerts,
            lc.receipt_number AS lpr_number,
            lc.status AS lpr_status,
            lc.reversed_at AS lpr_reversed_at,
            lc.replaced AS lpr_replaced,
            lc.reversed AS lpr_reversed
           FROM base b
             LEFT JOIN ocr o ON o.withdrawal_request_id = b.withdrawal_id AND o.storage_path = b.payout_proof_path
             CROSS JOIN xtid_map xm
             LEFT JOIN wref_use wu ON wu.ref = b.ref_withdrawal
             LEFT JOIN ref_all ra ON ra.ref = COALESCE(b.ref_withdrawal, b.ref_finops)
             LEFT JOIN alerts al ON al.withdrawal_id = b.withdrawal_id
             LEFT JOIN lpr_current lc ON lc.payout_id = b.payout_id
        ), rc AS (
         SELECT r.payout_id,
            r.rent_request_id,
            r.landlord_id,
            r.landlord_name,
            r.landlord_phone,
            r.mobile_money_provider,
            r.amount,
            r.payout_status,
            r.created_at,
            r.withdrawal_id,
            r.ref_withdrawal,
            r.paid_amount,
            r.receipt_token,
            r.payout_proof_path,
            r.proof_bucket,
            r.payout_proof_uploaded_at,
            r.ref_finops,
            r.paid_out,
            r.paid_at,
            r.paid_date_source,
            r.float_week_start,
            r.weekly_budget_id,
            r.allocation_kind,
            r.check_id,
            r.checked_at,
            r.validation_result,
            r.validation_code,
            r.xtid,
            r.xamt,
            r.xdate,
            r.has_receipt,
            r.file_accessible,
            r.xtid_uses,
            r.ref_uses,
            r.ref_payouts,
            r.open_alerts,
            r.lpr_number,
            r.lpr_status,
            r.lpr_reversed_at,
            r.lpr_replaced,
            r.lpr_reversed,
            ARRAY( SELECT t.t
                   FROM unnest(COALESCE(r.open_alerts, '{}'::text[])) t(t)
                  WHERE t.t <> 'proof_missing'::text) AS blocking_alerts,
            r.xtid IS NOT NULL AND r.xamt IS NOT NULL AS fields_read,
            r.xtid IS NOT NULL AND (length(r.xtid) = ANY (ARRAY[11, 12])) AND r.xtid = r.ref_withdrawal AS ref_ok,
            r.xamt IS NOT NULL AND round(r.xamt) = round(r.paid_amount) AND round(r.paid_amount) = round(r.amount) AS amount_ok,
            r.xtid_uses > 1 OR r.ref_uses > 1 OR r.ref_payouts > 1 AS duplicated
           FROM rc0 r
        ), fin AS (
         SELECT r.payout_id,
            r.rent_request_id,
            r.landlord_id,
            r.landlord_name,
            r.landlord_phone,
            r.mobile_money_provider,
            r.amount,
            r.payout_status,
            r.created_at,
            r.withdrawal_id,
            COALESCE(r.ref_withdrawal, r.ref_finops) AS payout_reference,
            r.paid_out,
            r.paid_at,
            (r.paid_at AT TIME ZONE 'Africa/Kampala'::text)::date AS paid_date,
            r.paid_date_source,
            r.float_week_start IS NOT NULL AS has_weekly_float,
            r.float_week_start,
            r.weekly_budget_id,
            r.allocation_kind,
            COALESCE(r.float_week_start, landlord_float_week_start((COALESCE(r.paid_at, r.created_at) AT TIME ZONE 'Africa/Kampala'::text)::date)) AS report_week_start,
            r.paid_amount,
            r.receipt_token,
            r.payout_proof_path AS receipt_file_path,
            r.file_accessible AS receipt_file_accessible,
            r.payout_proof_uploaded_at AS receipt_uploaded_at,
            r.check_id AS receipt_check_id,
            r.checked_at AS receipt_checked_at,
            r.validation_result AS receipt_check_result,
            r.validation_code AS receipt_check_code,
            r.xtid AS receipt_tid_read,
            r.xamt AS receipt_amount_read,
            r.xdate AS receipt_date_read,
            r.blocking_alerts,
            r.lpr_number AS landlord_receipt_number,
            r.lpr_status AS landlord_receipt_status,
            r.lpr_reversed_at AS landlord_receipt_reversed_at,
            COALESCE(r.lpr_replaced, false) AS landlord_receipt_replaced,
            COALESCE(r.lpr_reversed, false) AS landlord_receipt_reversed,
                CASE
                    WHEN NOT r.paid_out THEN NULL::text
                    WHEN r.withdrawal_id IS NULL THEN 'no_archive_record'::text
                    WHEN NOT r.has_receipt OR NOT r.file_accessible THEN 'receipt_missing'::text
                    WHEN r.check_id IS NULL THEN 'receipt_unchecked'::text
                    WHEN r.validation_result = 'mismatch'::text THEN 'receipt_contradicts'::text
                    WHEN r.validation_result IS DISTINCT FROM 'match'::text THEN 'receipt_unreadable'::text
                    WHEN NOT r.fields_read THEN 'receipt_incomplete'::text
                    WHEN NOT r.ref_ok THEN 'receipt_reference_differs'::text
                    WHEN NOT r.amount_ok THEN 'receipt_amount_differs'::text
                    WHEN r.duplicated THEN 'receipt_duplicate'::text
                    WHEN cardinality(r.blocking_alerts) > 0 THEN 'receipt_alert_open'::text
                    ELSE 'receipt_verified'::text
                END AS receipt_state
           FROM rc r
        ), st AS (
         SELECT f.payout_id,
            f.rent_request_id,
            f.landlord_id,
            f.landlord_name,
            f.landlord_phone,
            f.mobile_money_provider,
            f.amount,
            f.payout_status,
            f.created_at,
            f.withdrawal_id,
            f.payout_reference,
            f.paid_out,
            f.paid_at,
            f.paid_date,
            f.paid_date_source,
            f.has_weekly_float,
            f.float_week_start,
            f.weekly_budget_id,
            f.allocation_kind,
            f.report_week_start,
            f.paid_amount,
            f.receipt_token,
            f.receipt_file_path,
            f.receipt_file_accessible,
            f.receipt_uploaded_at,
            f.receipt_check_id,
            f.receipt_checked_at,
            f.receipt_check_result,
            f.receipt_check_code,
            f.receipt_tid_read,
            f.receipt_amount_read,
            f.receipt_date_read,
            f.blocking_alerts,
            f.landlord_receipt_number,
            f.landlord_receipt_status,
            f.landlord_receipt_reversed_at,
            f.landlord_receipt_replaced,
            f.landlord_receipt_reversed,
            f.receipt_state,
            f.receipt_state = 'receipt_verified'::text AS receipt_verified,
                CASE
                    WHEN f.paid_out AND f.receipt_state = 'receipt_verified'::text THEN 'confirmed'::text
                    WHEN f.paid_out AND NOT f.has_weekly_float THEN 'historical_review'::text
                    WHEN f.paid_out THEN 'paid_unconfirmed'::text
                    WHEN f.payout_status = 'failed'::text THEN 'failed'::text
                    ELSE 'not_paid'::text
                END AS state
           FROM fin f
        ), ex AS (
         SELECT s.payout_id,
            s.rent_request_id,
            s.landlord_id,
            s.landlord_name,
            s.landlord_phone,
            s.mobile_money_provider,
            s.amount,
            s.payout_status,
            s.created_at,
            s.withdrawal_id,
            s.payout_reference,
            s.paid_out,
            s.paid_at,
            s.paid_date,
            s.paid_date_source,
            s.has_weekly_float,
            s.float_week_start,
            s.weekly_budget_id,
            s.allocation_kind,
            s.report_week_start,
            s.paid_amount,
            s.receipt_token,
            s.receipt_file_path,
            s.receipt_file_accessible,
            s.receipt_uploaded_at,
            s.receipt_check_id,
            s.receipt_checked_at,
            s.receipt_check_result,
            s.receipt_check_code,
            s.receipt_tid_read,
            s.receipt_amount_read,
            s.receipt_date_read,
            s.blocking_alerts,
            s.landlord_receipt_number,
            s.landlord_receipt_status,
            s.landlord_receipt_reversed_at,
            s.landlord_receipt_replaced,
            s.landlord_receipt_reversed,
            s.receipt_state,
            s.receipt_verified,
            s.state,
            array_remove(ARRAY[
                CASE
                    WHEN s.paid_out AND s.payout_status = 'failed'::text THEN 'failed_but_paid'::text
                    ELSE NULL::text
                END,
                CASE
                    WHEN NOT s.paid_out AND s.payout_status = 'completed'::text THEN 'completed_without_payout'::text
                    ELSE NULL::text
                END,
                CASE
                    WHEN s.landlord_receipt_reversed THEN 'landlord_receipt_reversed'::text
                    ELSE NULL::text
                END,
                CASE
                    WHEN s.receipt_state = ANY (ARRAY['receipt_contradicts'::text, 'receipt_unreadable'::text, 'receipt_incomplete'::text, 'receipt_reference_differs'::text, 'receipt_amount_differs'::text, 'receipt_duplicate'::text, 'receipt_alert_open'::text]) THEN s.receipt_state
                    ELSE NULL::text
                END,
                CASE
                    WHEN s.paid_out AND NOT s.receipt_verified AND s.receipt_state <> 'receipt_duplicate'::text AND s.receipt_tid_read IS NOT NULL AND r2.duplicated THEN 'receipt_duplicate'::text
                    ELSE NULL::text
                END,
                CASE
                    WHEN s.paid_out AND NOT s.receipt_verified AND s.receipt_state <> 'receipt_alert_open'::text AND cardinality(s.blocking_alerts) > 0 THEN 'receipt_alert_open'::text
                    ELSE NULL::text
                END,
                CASE
                    WHEN s.paid_out AND s.paid_amount IS NOT NULL AND s.paid_amount <> s.amount THEN 'paid_amount_differs'::text
                    ELSE NULL::text
                END,
                CASE
                    WHEN s.paid_out AND NOT s.receipt_verified AND (length(COALESCE(s.payout_reference, ''::text)) <> ALL (ARRAY[11, 12])) THEN 'reference_unusable'::text
                    ELSE NULL::text
                END,
                CASE
                    WHEN s.paid_out AND NOT s.receipt_verified AND r2.ref_payouts > 1 THEN 'shared_reference'::text
                    ELSE NULL::text
                END], NULL::text) AS exceptions
           FROM st s
             JOIN rc r2 ON r2.payout_id = s.payout_id
        )
 SELECT ex.payout_id,
    ex.rent_request_id,
    ex.landlord_id,
    ex.landlord_name,
    ex.landlord_phone,
    ex.mobile_money_provider,
    ex.amount,
    ex.payout_status,
    ex.created_at,
    ex.withdrawal_id,
    ex.payout_reference,
    ex.paid_out,
    ex.paid_at,
    ex.paid_date,
    ex.paid_date_source,
    ex.has_weekly_float,
    ex.float_week_start,
    ex.weekly_budget_id,
    ex.allocation_kind,
    ex.report_week_start,
    ex.paid_amount,
    ex.receipt_token,
    ex.receipt_file_path,
    ex.receipt_file_accessible,
    ex.receipt_uploaded_at,
    ex.receipt_check_id,
    ex.receipt_checked_at,
    ex.receipt_check_result,
    ex.receipt_check_code,
    ex.receipt_tid_read,
    ex.receipt_amount_read,
    ex.receipt_date_read,
    ex.blocking_alerts,
    ex.landlord_receipt_number,
    ex.landlord_receipt_status,
    ex.landlord_receipt_reversed_at,
    ex.landlord_receipt_replaced,
    ex.landlord_receipt_reversed,
    ex.receipt_state,
    ex.receipt_verified,
    ex.state,
    ex.exceptions,
    ex.exceptions[1] AS exception,
    ex.exceptions && ARRAY['failed_but_paid'::text, 'completed_without_payout'::text, 'landlord_receipt_reversed'::text, 'receipt_contradicts'::text, 'receipt_unreadable'::text, 'receipt_incomplete'::text, 'receipt_reference_differs'::text, 'receipt_amount_differs'::text, 'receipt_duplicate'::text, 'receipt_alert_open'::text, 'paid_amount_differs'::text, 'reference_unusable'::text, 'shared_reference'::text] AS under_review,
        CASE
            WHEN ex.state = 'paid_unconfirmed'::text THEN
            CASE
                WHEN ex.exceptions && ARRAY['failed_but_paid'::text, 'completed_without_payout'::text, 'landlord_receipt_reversed'::text, 'receipt_contradicts'::text, 'receipt_unreadable'::text, 'receipt_incomplete'::text, 'receipt_reference_differs'::text, 'receipt_amount_differs'::text, 'receipt_duplicate'::text, 'receipt_alert_open'::text, 'paid_amount_differs'::text, 'reference_unusable'::text, 'shared_reference'::text] THEN 'under_review'::text
                ELSE 'awaiting_receipt'::text
            END
            ELSE NULL::text
        END AS payable_class,
    nf.basis IS NOT NULL AS approved_no_float,
    nf.basis AS no_float_basis
   FROM ex
     LEFT JOIN LATERAL ( SELECT
                CASE
                    WHEN COALESCE(ex.payout_status, ''::text) <> ALL (ARRAY['completed'::text, 'failed'::text]) THEN 'approved_unpaid'::text
                    WHEN (EXISTS ( SELECT 1
                       FROM rent_requests rq
                      WHERE rq.id = ex.rent_request_id AND (rq.status = ANY (ARRAY['funded'::text, 'repaying'::text])))) AND (EXISTS ( SELECT 1
                       FROM agent_landlord_float_allocations aa
                      WHERE aa.rent_request_id = ex.rent_request_id AND aa.status = 'open'::text)) AND NOT (EXISTS ( SELECT 1
                       FROM ex e2
                      WHERE e2.rent_request_id = ex.rent_request_id AND e2.payout_id <> ex.payout_id AND (e2.paid_out OR e2.has_weekly_float OR (COALESCE(e2.payout_status, ''::text) <> ALL (ARRAY['completed'::text, 'failed'::text])) OR ((ROW(e2.created_at, e2.payout_id) > ROW(ex.created_at, ex.payout_id)))))) THEN 'attempt_ended_unpaid'::text
                    ELSE NULL::text
                END AS basis
          WHERE NOT ex.paid_out AND NOT ex.has_weekly_float) nf ON true;

-- 2. Weekly floats: the settlement view read once.
CREATE OR REPLACE VIEW public.v_landlord_float_payables AS
WITH ls AS MATERIALIZED (
         SELECT s.rent_request_id, s.paid_out, s.has_weekly_float, s.float_week_start, s.amount, s.state
           FROM v_landlord_payout_settlement s
        ), fl AS (
         SELECT DISTINCT ON (b.period_start) b.id AS float_id,
            b.period_start AS week_start,
            b.period_end AS week_end,
            b.amount AS float_set,
            b.created_at
           FROM landlord_float_budgets b
          WHERE b.period_type = 'weekly'::text AND b.superseded_at IS NULL
          ORDER BY b.period_start, b.created_at DESC, b.id
        ), al AS (
         SELECT a_1.week_start,
            a_1.rent_request_id,
            a_1.kind,
            a_1.amount
           FROM landlord_float_budget_allocations a_1
          WHERE a_1.released_at IS NULL
        ), paid_rr AS (
         SELECT DISTINCT s.rent_request_id
           FROM ls s
          WHERE s.paid_out AND s.rent_request_id IS NOT NULL
        ), agg_al AS (
         SELECT al.week_start,
            COALESCE(sum(al.amount) FILTER (WHERE al.kind = 'within_cap'::text), 0::numeric) AS within_cap_approved,
            COALESCE(sum(al.amount) FILTER (WHERE al.kind = 'miscellaneous'::text), 0::numeric) AS misc_approved,
            count(*) AS approved_count,
            COALESCE(sum(al.amount) FILTER (WHERE p_1.rent_request_id IS NULL), 0::numeric) AS approved_not_paid,
            count(*) FILTER (WHERE p_1.rent_request_id IS NULL) AS approved_not_paid_count
           FROM al
             LEFT JOIN paid_rr p_1 ON p_1.rent_request_id = al.rent_request_id
          GROUP BY al.week_start
        ), agg_pay AS (
         SELECT s.float_week_start AS week_start,
            COALESCE(sum(s.amount) FILTER (WHERE s.state = 'confirmed'::text), 0::numeric) AS verified_paid,
            count(*) FILTER (WHERE s.state = 'confirmed'::text) AS verified_count,
            COALESCE(sum(s.amount) FILTER (WHERE s.state = 'paid_unconfirmed'::text), 0::numeric) AS unverified_paid,
            count(*) FILTER (WHERE s.state = 'paid_unconfirmed'::text) AS unverified_count
           FROM ls s
          WHERE s.has_weekly_float
          GROUP BY s.float_week_start
        )
 SELECT fl.float_id,
    fl.week_start,
    fl.week_end,
    fl.float_set,
    COALESCE(a.misc_approved, 0::numeric) AS misc_approved,
    fl.float_set + COALESCE(a.misc_approved, 0::numeric) AS allowance,
    COALESCE(a.within_cap_approved, 0::numeric) AS within_cap_approved,
    COALESCE(a.approved_count, 0::bigint) AS approved_count,
    COALESCE(a.approved_not_paid, 0::numeric) AS approved_not_paid,
    COALESCE(a.approved_not_paid_count, 0::bigint) AS approved_not_paid_count,
    COALESCE(p.verified_paid, 0::numeric) AS verified_paid,
    COALESCE(p.verified_count, 0::bigint) AS verified_count,
    COALESCE(p.unverified_paid, 0::numeric) AS unverified_paid,
    COALESCE(p.unverified_count, 0::bigint) AS unverified_count,
        CASE
            WHEN fl.week_end >= (now() AT TIME ZONE 'Africa/Kampala'::text)::date THEN GREATEST(fl.float_set + COALESCE(a.misc_approved, 0::numeric) - COALESCE(p.verified_paid, 0::numeric), 0::numeric)
            ELSE GREATEST(COALESCE(a.within_cap_approved, 0::numeric) + COALESCE(a.misc_approved, 0::numeric) - COALESCE(p.verified_paid, 0::numeric), 0::numeric)
        END AS outstanding_amount,
    COALESCE(p.verified_paid, 0::numeric) > (fl.float_set + COALESCE(a.misc_approved, 0::numeric)) AS overspent,
    GREATEST(COALESCE(p.verified_paid, 0::numeric) - fl.float_set - COALESCE(a.misc_approved, 0::numeric), 0::numeric) AS overspent_amount,
    fl.week_end < (now() AT TIME ZONE 'Africa/Kampala'::text)::date AS week_ended,
    GREATEST(COALESCE(a.within_cap_approved, 0::numeric) + COALESCE(a.misc_approved, 0::numeric) - COALESCE(p.verified_paid, 0::numeric), 0::numeric) AS open_obligation,
        CASE
            WHEN fl.week_end >= (now() AT TIME ZONE 'Africa/Kampala'::text)::date THEN 0::numeric
            ELSE GREATEST(fl.float_set + COALESCE(a.misc_approved, 0::numeric) - GREATEST(COALESCE(a.within_cap_approved, 0::numeric) + COALESCE(a.misc_approved, 0::numeric), COALESCE(p.verified_paid, 0::numeric)), 0::numeric)
        END AS lapsed_unused,
    fl.created_at
   FROM fl
     LEFT JOIN agg_al a ON a.week_start = fl.week_start
     LEFT JOIN agg_pay p ON p.week_start = fl.week_start;

-- 3. Payables functions: one read of the payables list per call.
CREATE OR REPLACE FUNCTION public.get_payables_total()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_result jsonb;
BEGIN
  PERFORM payables_guard();

  -- One read of the payables list per call (it was read five times).
  WITH l0 AS MATERIALIZED (SELECT * FROM v_payables_lines)
  SELECT jsonb_build_object(
    'currency','UGX',
    'as_at', now(),
    'total', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM l0),0),
    'item_count', COALESCE((SELECT COUNT(*) FROM l0),0),
    'overdue', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM l0
                          WHERE due_date IS NOT NULL AND due_date < (now() AT TIME ZONE 'Africa/Nairobi')::date),0),
    'due_today', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM l0
                          WHERE due_date = (now() AT TIME ZONE 'Africa/Nairobi')::date),0),
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'key', c.category_key, 'label', c.category_label,
               'outstanding', c.outstanding, 'item_count', c.item_count
             ) ORDER BY c.sort_order)
      FROM (
        SELECT f.category_key, f.category_label, f.sort_order,
               ROUND(COALESCE(SUM(l.outstanding_amount),0),2) AS outstanding,
               COUNT(l.item_id) AS item_count
        FROM payables_category_frame() f
        LEFT JOIN l0 l ON l.category_key = f.category_key
        GROUP BY f.category_key, f.category_label, f.sort_order
      ) c
    ), '[]'::jsonb),
    'source','v_payables_lines'
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_payables_breakdown()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric := 0;
  v_cats jsonb := '[]'::jsonb;
  v_cat_total numeric := 0;
BEGIN
  PERFORM payables_guard();

  -- One read of the payables list per call (it was read twice); the total comes from the same read.
  WITH l0 AS MATERIALIZED (SELECT * FROM v_payables_lines),
  ranked AS (
    SELECT l.*, ROW_NUMBER() OVER (PARTITION BY l.product_key ORDER BY l.outstanding_amount DESC) AS rn
    FROM l0 l
  ), products AS (
    SELECT category_key, product_key, product_label, source_table,
           ROUND(SUM(outstanding_amount),2) AS outstanding,
           COUNT(*) AS item_count,
           SUM(CASE WHEN due_kind = 'scheduled' THEN outstanding_amount ELSE 0 END) AS scheduled_amount,
           SUM(CASE WHEN due_kind = 'projected' THEN outstanding_amount ELSE 0 END) AS projected_amount,
           COALESCE(jsonb_agg(jsonb_build_object(
             'item_id', item_id, 'counterparty', counterparty_name,
             'amount', ROUND(outstanding_amount,2), 'due_date', due_date,
             'due_kind', due_kind, 'status', status, 'source', source_table
           ) ORDER BY outstanding_amount DESC) FILTER (WHERE rn <= 100), '[]'::jsonb) AS items
    FROM ranked
    GROUP BY category_key, product_key, product_label, source_table
  )
  SELECT jsonb_agg(jsonb_build_object(
           'key', f.category_key, 'label', f.category_label,
           'outstanding', ROUND(COALESCE(c.outstanding,0),2),
           'item_count', COALESCE(c.item_count,0),
           'products', COALESCE(c.products,'[]'::jsonb)
         ) ORDER BY f.sort_order),
         COALESCE(SUM(c.outstanding),0),
         (SELECT COALESCE(ROUND(SUM(outstanding_amount),2),0) FROM l0)
    INTO v_cats, v_cat_total, v_total
  FROM payables_category_frame() f
  LEFT JOIN (
    SELECT category_key,
           SUM(outstanding) AS outstanding,
           SUM(item_count) AS item_count,
           jsonb_agg(jsonb_build_object(
             'key', product_key, 'label', product_label, 'source', source_table,
             'outstanding', outstanding, 'item_count', item_count,
             'scheduled_amount', ROUND(scheduled_amount,2),
             'projected_amount', ROUND(projected_amount,2),
             'items', items
           ) ORDER BY outstanding DESC) AS products
    FROM products GROUP BY category_key
  ) c ON c.category_key = f.category_key;

  RETURN jsonb_build_object(
    'currency','UGX', 'as_at', now(),
    'total', v_total,
    'categories', COALESCE(v_cats,'[]'::jsonb),
    'validation', jsonb_build_object(
      'categories_total', ROUND(v_cat_total,2),
      'authoritative_total', v_total,
      'difference', ROUND(v_cat_total - v_total, 2),
      'ties_out', abs(v_cat_total - v_total) < 0.01
    ),
    'source','v_payables_lines'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_payables_contract_schedule(p_granularity text DEFAULT 'day'::text, p_periods integer DEFAULT 7, p_as_at date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gran text := lower(COALESCE(p_granularity,'day'));
  v_periods integer := LEAST(GREATEST(COALESCE(p_periods,7),1),60);
  v_today date := COALESCE(p_as_at,(now() AT TIME ZONE 'Africa/Nairobi')::date);
  v_step interval;
  v_base date;
  v_result jsonb;
BEGIN
  PERFORM payables_guard();
  IF v_gran NOT IN ('day','week','month','quarter','year') THEN v_gran := 'day'; END IF;
  v_step := CASE v_gran WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week'
            WHEN 'month' THEN interval '1 month' WHEN 'quarter' THEN interval '3 months' ELSE interval '1 year' END;
  v_base := CASE v_gran WHEN 'day' THEN v_today WHEN 'week' THEN date_trunc('week',v_today)::date
            WHEN 'month' THEN date_trunc('month',v_today)::date WHEN 'quarter' THEN date_trunc('quarter',v_today)::date
            ELSE date_trunc('year',v_today)::date END;
  -- Contractual schedule from every open obligation with a due date, regardless of payment history.
  -- Overdue obligations (due before today) are contractually payable now, so they land in the first period.
  -- One read of the payables list per call (it was read once or twice per period).
  WITH l0 AS MATERIALIZED (SELECT l.due_date, l.outstanding_amount FROM v_payables_lines l WHERE l.due_date IS NOT NULL)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'index', i, 'period_start', ps, 'contract_amount', COALESCE(amt,0), 'overdue_included', COALESCE(od,0)
    ) ORDER BY i), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT i, ps,
      (SELECT ROUND(SUM(l.outstanding_amount),2) FROM l0 l
        WHERE l.due_date IS NOT NULL AND (
          (l.due_date BETWEEN GREATEST(ps, v_today) AND pe)
          OR (i = 0 AND l.due_date < v_today))) AS amt,
      CASE WHEN i = 0 THEN (SELECT ROUND(SUM(l.outstanding_amount),2) FROM l0 l
        WHERE l.due_date IS NOT NULL AND l.due_date < v_today) END AS od
    FROM (SELECT i, (v_base + (v_step * i))::date ps,
                 ((v_base + (v_step * (i+1))) - interval '1 day')::date pe
          FROM generate_series(0, v_periods-1) i) x
  ) y;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_payables_due_range(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Nairobi')::date;
  v_result jsonb;
BEGIN
  PERFORM payables_guard();

  -- One read of the payables list per call (it was read five times).
  WITH l0 AS MATERIALIZED (SELECT * FROM v_payables_lines)
  SELECT jsonb_build_object(
    'currency','UGX',
    'from', p_from,
    'to', p_to,
    'business_date', v_today,
    'due_in_range', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM l0
                              WHERE due_date IS NOT NULL AND due_date BETWEEN p_from AND p_to),0),
    'item_count', COALESCE((SELECT COUNT(*) FROM l0
                            WHERE due_date IS NOT NULL AND due_date BETWEEN p_from AND p_to),0),
    'overdue', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM l0
                          WHERE due_date IS NOT NULL AND due_date < p_from),0),
    'outstanding', COALESCE((SELECT ROUND(SUM(outstanding_amount),2) FROM l0),0),
    'paid_in_range', COALESCE((SELECT ROUND(SUM(amount),2) FROM v_payables_payment_history
                               WHERE d BETWEEN p_from AND p_to),0),
    'rows', COALESCE((
      SELECT jsonb_agg(r) FROM (
        SELECT item_id AS id, counterparty_id AS user_id, counterparty_name AS name,
               ROUND(outstanding_amount,2) AS amount, status, due_date,
               product_label, category_label
        FROM l0
        WHERE due_date IS NOT NULL AND due_date BETWEEN p_from AND p_to
        ORDER BY outstanding_amount DESC
        LIMIT 300
      ) r
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;
