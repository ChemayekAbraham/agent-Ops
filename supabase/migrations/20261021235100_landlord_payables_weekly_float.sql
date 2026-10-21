-- 2026-10-21: payables part 3 — the payables the CFO records, with landlord payouts evidenced by the Receipt Archive.
--
-- Decided by the CFO (2026-10-21): the payables recorded in the system are
--   1. Supporter Returns                (unchanged branch)
--   2. the Landlord Float Payout Budget  (new: below)
--   3. agent commission payouts          (unchanged branch)
--   4. Departmental Budgets              (Part 2, unchanged branch)
-- User wallet balances, withdrawal requests in flight, agent float withdrawals and payroll are NOT payables any more:
-- their branches leave v_payables_lines and v_payables_payment_history, and payables_category_frame lists only the four.
-- (Those balances still exist in wallets and the ledger; this changes only what the payables report records.)
-- get_payables_predictive_forecast stops modelling new obligations for them (and for per-payout landlord items, which
-- the weekly float line replaces); it otherwise stays production's definition.
--
-- LANDLORD FLOAT PAYOUT BUDGET (v_landlord_float_payables): each current weekly landlord float the CFO sets
-- (landlord_float_budgets, weekly) is payable at its allowance = the float + CFO-approved miscellaneous approvals above it
-- (landlord_float_budget_allocations kind 'miscellaneous'), less landlord payouts made against it (allocations by rent
-- request) that the Receipt Archive has verified. Paid-out but unverified payouts stay inside it; verified payouts above
-- the allowance flag the float as overspent. One payables line per float, due at the end of its week.
-- AFTER THE WEEK ENDS (CFO decision 2026-10-21): nothing more can be approved against the float and nothing rolls
-- over, so the float stays payable only for its approvals (within the cap + miscellaneous) not yet verified; the unused
-- allowance lapses (lapsed_unused) and is reported, never payable.
--
-- RECEIPT ARCHIVE VERIFICATION (v_landlord_payout_settlement): the Receipt Archive on the Financial Operations
-- dashboard is the SOLE evidence. A landlord payout is CONFIRMED (verified) only when ALL of these hold:
--   1. it was paid through a completed withdrawal linked by landlord_payout_id;
--   2. that withdrawal has a receipt token and a proof file that exists in storage;
--   3. the latest machine check (payout_proof_ocr_log) of THAT EXACT file is 'match';
--   4. the transaction ID read from the receipt equals the withdrawal reference, and
--   5. is 11 (MTN) or 12 (Airtel) digits (the provider cannot be established reliably, so no provider-specific length);
--   6. the amount read equals the withdrawal amount, which equals the payout amount;
--   7. no other payout or withdrawal has a receipt with that ID or the same reference;
--   8. no open integrity alert makes the receipt unreliable ('proof_missing' never blocks on its own);
--   9. a missing or unreadable ID or amount is never a match.
-- Provider SMS, provider statements and probable matches never confirm.
-- Landlord payouts paid out WITHOUT a weekly float (before the float regime) and not verified are HISTORICAL REVIEW items
-- for the CFO: neither confirmed nor payable. landlord_receipt_reversed flags a payout whose current Welile landlord
-- receipt is reversed or refunded (flag only). Payout dates come from the payout record, never the receipt upload time.
--
-- REPORTING ONLY. No ledger entry, wallet, payout, withdrawal, receipt, allocation or status is written; no OCR or
-- approval is run. Requires 20261020210000_budget_payables: its v_payables_lines / v_payables_payment_history bodies are
-- pinned and its category frame is checked; every branch kept is verbatim.
-- Rollback: supabase/rollbacks/20261021235100_landlord_payables_weekly_float.rollback.sql
-- Verification (rolled back, read-only): supabase/tests/landlord_payables_weekly_float.sql

-- 0. Safety: fail fast on locks; refuse unless Part 2's definitions are exactly the ones embedded below.
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF md5(pg_get_viewdef('public.v_payables_lines'::regclass)) <> '9839b8fa221452125d384782c6444801' THEN
    RAISE EXCEPTION 'precondition failed: v_payables_lines is not the definition 20261020210000 created (md5 %); regenerate this migration', md5(pg_get_viewdef('public.v_payables_lines'::regclass));
  END IF;
  IF md5(pg_get_viewdef('public.v_payables_payment_history'::regclass)) <> '3535fea07816f4dbec42b1a259e38835' THEN
    RAISE EXCEPTION 'precondition failed: v_payables_payment_history is not the definition 20261020210000 created (md5 %); regenerate this migration', md5(pg_get_viewdef('public.v_payables_payment_history'::regclass));
  END IF;
  IF (SELECT string_agg(category_key || ':' || sort_order, ',' ORDER BY sort_order) FROM public.payables_category_frame()) IS DISTINCT FROM 'user:1,partner:2,landlord:3,agent:4,staff:5,budget:6,other:7' THEN
    RAISE EXCEPTION 'precondition failed: payables_category_frame is not the one 20261020210000 created; regenerate this migration';
  END IF;
  IF to_regprocedure('public.get_payables_predictive_forecast(text,integer,date)') IS NULL
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_payables_predictive_forecast(text,integer,date)'::regprocedure) <> '729d81a15c58a8dbaf8d31f1611af6d8' THEN
    RAISE EXCEPTION 'precondition failed: get_payables_predictive_forecast is not the production definition this migration edits; regenerate this migration';
  END IF;
  IF to_regclass('public.landlord_payouts') IS NULL OR to_regclass('public.withdrawal_requests') IS NULL
     OR to_regclass('public.payout_proof_ocr_log') IS NULL OR to_regclass('public.payout_proof_integrity_alerts') IS NULL
     OR to_regclass('storage.objects') IS NULL OR to_regclass('public.profiles') IS NULL
     OR to_regprocedure('public.landlord_float_week_start(date)') IS NULL OR to_regprocedure('public.payables_guard()') IS NULL
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'withdrawal_requests'
            AND column_name IN ('landlord_payout_id', 'receipt_token', 'payout_proof_path', 'payout_proof_bucket',
                                'payout_proof_uploaded_at', 'transaction_id', 'fin_ops_reference', 'processed_at')) <> 8
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'payout_proof_ocr_log'
            AND column_name IN ('withdrawal_request_id', 'storage_path', 'validation_result', 'validation_code',
                                'extracted_tid', 'extracted_amount', 'extracted_date', 'created_at')) <> 8
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'payout_proof_integrity_alerts'
            AND column_name IN ('withdrawal_id', 'issue_type', 'resolved')) <> 3
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'landlord_payout_receipts'
            AND column_name IN ('id', 'payout_id', 'receipt_number', 'status', 'reversed_at', 'replaces_receipt_id', 'created_at')) <> 7
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'landlord_float_budgets'
            AND column_name IN ('id', 'period_type', 'period_start', 'period_end', 'amount', 'superseded_at', 'created_at')) <> 7
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'landlord_float_budget_allocations'
            AND column_name IN ('rent_request_id', 'kind', 'amount', 'week_start', 'approved_at', 'released_at')) <> 6 THEN
    RAISE EXCEPTION 'precondition failed: a table, column or function this migration depends on is missing';
  END IF;
END
$pre$;

-- 1. One row per landlord payout: paid out?, which weekly float, its Receipt Archive evidence check by check,
--    the group it belongs to and its exceptions.
CREATE OR REPLACE VIEW public.v_landlord_payout_settlement AS
WITH wr AS (                          -- the completed withdrawal that paid the landlord: its Receipt Archive record
  SELECT DISTINCT ON (w.landlord_payout_id)
         w.landlord_payout_id, w.id AS withdrawal_id, w.processed_at, w.amount AS paid_amount,
         w.receipt_token, w.payout_proof_path, COALESCE(w.payout_proof_bucket, 'payment-proofs') AS proof_bucket,
         w.payout_proof_uploaded_at,
         NULLIF(regexp_replace(COALESCE(NULLIF(w.transaction_id, ''), w.fin_ops_reference, ''), '[^0-9]', '', 'g'), '') AS ref
    FROM public.withdrawal_requests w
   WHERE w.landlord_payout_id IS NOT NULL AND w.status = 'completed'
   ORDER BY w.landlord_payout_id, w.processed_at DESC NULLS LAST
),
alloc AS (                       -- the CFO weekly landlord float that approved the rent request
  SELECT DISTINCT ON (a.rent_request_id) a.rent_request_id, a.week_start, a.weekly_budget_id, a.kind
    FROM public.landlord_float_budget_allocations a
   WHERE a.released_at IS NULL AND a.rent_request_id IS NOT NULL
     -- only a week that has a current weekly float: otherwise the payout would be in no float's payable
     AND EXISTS (SELECT 1 FROM public.landlord_float_budgets b
                  WHERE b.period_type = 'weekly' AND b.superseded_at IS NULL AND b.period_start = a.week_start)
   ORDER BY a.rent_request_id, a.approved_at DESC NULLS LAST
),
base AS (
  SELECT lp.id AS payout_id, lp.rent_request_id, lp.landlord_id,
         COALESCE(NULLIF(lp.landlord_name, ''), pr.full_name) AS landlord_name,
         lp.landlord_phone, lp.mobile_money_provider, lp.amount, lp.status AS payout_status, lp.created_at,
         wr.withdrawal_id, wr.ref AS ref_withdrawal, wr.paid_amount, wr.receipt_token, wr.payout_proof_path,
         wr.proof_bucket, wr.payout_proof_uploaded_at,
         NULLIF(regexp_replace(COALESCE(lp.finops_momo_reference, ''), '[^0-9]', '', 'g'), '') AS ref_finops,
         (wr.withdrawal_id IS NOT NULL
          OR (NULLIF(regexp_replace(COALESCE(lp.finops_momo_reference, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
              AND lp.finops_disbursed_at IS NOT NULL)) AS paid_out,
         COALESCE(wr.processed_at, lp.finops_disbursed_at) AS paid_at,
         CASE WHEN wr.processed_at IS NOT NULL THEN 'withdrawal_completed'
              WHEN lp.finops_disbursed_at IS NOT NULL THEN 'finops_disbursed' END AS paid_date_source,
         al.week_start AS float_week_start, al.weekly_budget_id, al.kind AS allocation_kind
    FROM public.landlord_payouts lp
    LEFT JOIN wr ON wr.landlord_payout_id = lp.id
    LEFT JOIN alloc al ON al.rent_request_id = lp.rent_request_id
    LEFT JOIN public.profiles pr ON pr.id = lp.landlord_id
),
ocr AS (                         -- the latest machine check of each archived proof file
  SELECT DISTINCT ON (o.withdrawal_request_id, o.storage_path)
         o.withdrawal_request_id, o.storage_path, o.id AS check_id, o.created_at AS checked_at,
         o.validation_result, o.validation_code,
         NULLIF(regexp_replace(COALESCE(o.extracted_tid, ''), '[^0-9]', '', 'g'), '') AS xtid,
         o.extracted_amount AS xamt, o.extracted_date AS xdate
    FROM public.payout_proof_ocr_log o
   ORDER BY o.withdrawal_request_id, o.storage_path, o.created_at DESC
),
xtid_use AS (                    -- how many payouts / withdrawals have a current receipt showing each transaction ID
  SELECT o.xtid, count(DISTINCT COALESCE(w.landlord_payout_id, w.id)) AS uses
    FROM public.withdrawal_requests w
    JOIN ocr o ON o.withdrawal_request_id = w.id AND o.storage_path = w.payout_proof_path
   WHERE w.status = 'completed' AND o.xtid IS NOT NULL
   GROUP BY o.xtid
),
wref_use AS (                    -- the same reference recorded on completed withdrawals of other payouts / users
  SELECT x.ref, count(DISTINCT x.owner) AS uses
    FROM (SELECT NULLIF(regexp_replace(COALESCE(NULLIF(w.transaction_id, ''), w.fin_ops_reference, ''), '[^0-9]', '', 'g'), '') AS ref,
                 COALESCE(w.landlord_payout_id, w.id) AS owner
            FROM public.withdrawal_requests w WHERE w.status = 'completed') x
   WHERE x.ref IS NOT NULL
   GROUP BY x.ref
),
ref_all AS (                     -- how many landlord payouts carry each reference, in either field
  SELECT x.ref, count(DISTINCT x.payout_id) AS payouts
    FROM (SELECT payout_id, ref_withdrawal AS ref FROM base WHERE ref_withdrawal IS NOT NULL
          UNION ALL
          SELECT payout_id, ref_finops FROM base WHERE ref_finops IS NOT NULL) x
   GROUP BY x.ref
),
alerts AS (                      -- open integrity alerts per withdrawal
  SELECT a.withdrawal_id, array_agg(DISTINCT a.issue_type ORDER BY a.issue_type) AS issue_types
    FROM public.payout_proof_integrity_alerts a
   WHERE NOT a.resolved AND a.withdrawal_id IS NOT NULL
   GROUP BY a.withdrawal_id
),
lpr_current AS (                 -- the CURRENT Welile landlord payout receipt (landlord_payout_receipts) of each payout:
                                 -- its own receipt followed forward through replacements (a replacement points back via
                                 -- replaces_receipt_id and, because payout_id is unique, may carry another payout_id).
                                 -- The recursion is self-contained here, cycle- and depth-guarded.
  SELECT q.* FROM (
    WITH RECURSIVE lpr_walk AS (
      SELECT r.payout_id, r.id AS receipt_id, 0 AS depth, ARRAY[r.id] AS path
        FROM public.landlord_payout_receipts r
      UNION ALL
      SELECT w.payout_id, n.id, w.depth + 1, w.path || n.id
        FROM lpr_walk w
        JOIN public.landlord_payout_receipts n ON n.replaces_receipt_id = w.receipt_id
       WHERE w.depth < 20 AND NOT (n.id = ANY (w.path))
    )
    SELECT DISTINCT ON (w.payout_id) w.payout_id, r.receipt_number, r.status, r.reversed_at,
           (w.depth > 0) AS replaced,
           (r.reversed_at IS NOT NULL OR r.status IN ('reversed', 'refunded')) AS reversed
      FROM lpr_walk w
      JOIN public.landlord_payout_receipts r ON r.id = w.receipt_id
     ORDER BY w.payout_id, w.depth DESC, r.created_at DESC
  ) q
),
rc0 AS (                         -- the Receipt Archive evidence of each payout, check by check
  SELECT b.*, o.check_id, o.checked_at, o.validation_result, o.validation_code, o.xtid, o.xamt, o.xdate,
         (b.receipt_token IS NOT NULL AND b.payout_proof_path IS NOT NULL) AS has_receipt,
         (b.payout_proof_path IS NOT NULL
          AND EXISTS (SELECT 1 FROM storage.objects so
                       WHERE so.bucket_id = b.proof_bucket AND so.name = b.payout_proof_path)) AS file_accessible,
         COALESCE(xu.uses, 0) AS xtid_uses, COALESCE(wu.uses, 0) AS ref_uses, COALESCE(ra.payouts, 0) AS ref_payouts,
         al.issue_types AS open_alerts,
         lc.receipt_number AS lpr_number, lc.status AS lpr_status, lc.reversed_at AS lpr_reversed_at,
         lc.replaced AS lpr_replaced, lc.reversed AS lpr_reversed
    FROM base b
    LEFT JOIN ocr o ON o.withdrawal_request_id = b.withdrawal_id AND o.storage_path = b.payout_proof_path
    LEFT JOIN xtid_use xu ON xu.xtid = o.xtid
    LEFT JOIN wref_use wu ON wu.ref = b.ref_withdrawal
    LEFT JOIN ref_all ra ON ra.ref = COALESCE(b.ref_withdrawal, b.ref_finops)
    LEFT JOIN alerts al ON al.withdrawal_id = b.withdrawal_id
    LEFT JOIN lpr_current lc ON lc.payout_id = b.payout_id
),
rc AS (
  SELECT r.*,
         -- Every open alert blocks except 'proof_missing': detect_payout_proof_integrity raises it only when no proof was
         -- attached, so it is either stale (the file is now archived and accessible) or the same fact as receipt_missing.
         ARRAY(SELECT t FROM unnest(COALESCE(r.open_alerts, '{}'::text[])) t
                WHERE t <> 'proof_missing') AS blocking_alerts,
         (r.xtid IS NOT NULL AND r.xamt IS NOT NULL) AS fields_read,
         -- 11 (MTN) or 12 (Airtel) digits. The provider cannot be established reliably from the payout or the
         -- withdrawal, so a provider-specific length is not enforced.
         (r.xtid IS NOT NULL AND length(r.xtid) IN (11, 12) AND r.xtid = r.ref_withdrawal) AS ref_ok,
         (r.xamt IS NOT NULL AND round(r.xamt) = round(r.paid_amount) AND round(r.paid_amount) = round(r.amount)) AS amount_ok,
         (r.xtid_uses > 1 OR r.ref_uses > 1 OR r.ref_payouts > 1) AS duplicated
    FROM rc0 r
),
fin AS (
SELECT r.payout_id, r.rent_request_id, r.landlord_id, r.landlord_name, r.landlord_phone, r.mobile_money_provider,
       r.amount, r.payout_status, r.created_at, r.withdrawal_id,
       COALESCE(r.ref_withdrawal, r.ref_finops) AS payout_reference,
       r.paid_out, r.paid_at,
       (r.paid_at AT TIME ZONE 'Africa/Kampala')::date AS paid_date,
       r.paid_date_source,
       (r.float_week_start IS NOT NULL) AS has_weekly_float,
       r.float_week_start, r.weekly_budget_id, r.allocation_kind,
       COALESCE(r.float_week_start,
                public.landlord_float_week_start((COALESCE(r.paid_at, r.created_at) AT TIME ZONE 'Africa/Kampala')::date)) AS report_week_start,
       r.paid_amount,
       -- Receipt Archive evidence, shown as recorded (the upload time is the RECEIPT UPLOAD DATE, never a payout date;
       -- the date read from the image is unverified and never used as a payout date).
       r.receipt_token, r.payout_proof_path AS receipt_file_path, r.file_accessible AS receipt_file_accessible,
       r.payout_proof_uploaded_at AS receipt_uploaded_at,
       r.check_id AS receipt_check_id, r.checked_at AS receipt_checked_at,
       r.validation_result AS receipt_check_result, r.validation_code AS receipt_check_code,
       r.xtid AS receipt_tid_read, r.xamt AS receipt_amount_read, r.xdate AS receipt_date_read,
       r.blocking_alerts,
       -- The Welile landlord payout receipt (sent to the landlord). NOT payment evidence: shown, and its reversal flagged.
       r.lpr_number AS landlord_receipt_number, r.lpr_status AS landlord_receipt_status,
       r.lpr_reversed_at AS landlord_receipt_reversed_at, COALESCE(r.lpr_replaced, false) AS landlord_receipt_replaced,
       COALESCE(r.lpr_reversed, false) AS landlord_receipt_reversed,
       -- The first check the receipt fails (or receipt_verified when it passes them all).
       CASE
         WHEN NOT r.paid_out THEN NULL
         WHEN r.withdrawal_id IS NULL THEN 'no_archive_record'
         WHEN NOT r.has_receipt OR NOT r.file_accessible THEN 'receipt_missing'
         WHEN r.check_id IS NULL THEN 'receipt_unchecked'
         WHEN r.validation_result = 'mismatch' THEN 'receipt_contradicts'
         WHEN r.validation_result IS DISTINCT FROM 'match' THEN 'receipt_unreadable'
         WHEN NOT r.fields_read THEN 'receipt_incomplete'
         WHEN NOT r.ref_ok THEN 'receipt_reference_differs'
         WHEN NOT r.amount_ok THEN 'receipt_amount_differs'
         WHEN r.duplicated THEN 'receipt_duplicate'
         WHEN cardinality(r.blocking_alerts) > 0 THEN 'receipt_alert_open'
         ELSE 'receipt_verified'
       END AS receipt_state
  FROM rc r
),
st AS (
SELECT f.*,
       f.receipt_state = 'receipt_verified' AS receipt_verified,
       CASE WHEN f.paid_out AND f.receipt_state = 'receipt_verified' THEN 'confirmed'
            WHEN f.paid_out AND NOT f.has_weekly_float THEN 'historical_review'
            WHEN f.paid_out THEN 'paid_unconfirmed'
            WHEN f.payout_status = 'failed' THEN 'failed'
            ELSE 'not_paid' END AS state
  FROM fin f
),
ex AS (
SELECT s.*,
       -- Every exception that applies, most serious first; 'exception' is the first one. Exceptions never change an
       -- amount, a payout or a withdrawal.
       array_remove(ARRAY[
         CASE WHEN s.paid_out AND s.payout_status = 'failed' THEN 'failed_but_paid' END,
         CASE WHEN NOT s.paid_out AND s.payout_status = 'completed' THEN 'completed_without_payout' END,
         CASE WHEN s.landlord_receipt_reversed THEN 'landlord_receipt_reversed' END,
         CASE WHEN s.receipt_state IN ('receipt_contradicts', 'receipt_unreadable', 'receipt_incomplete',
                                       'receipt_reference_differs', 'receipt_amount_differs', 'receipt_duplicate',
                                       'receipt_alert_open') THEN s.receipt_state END,
         CASE WHEN s.paid_out AND NOT s.receipt_verified AND s.receipt_state <> 'receipt_duplicate'
                   AND s.receipt_tid_read IS NOT NULL AND r2.duplicated THEN 'receipt_duplicate' END,
         CASE WHEN s.paid_out AND NOT s.receipt_verified AND s.receipt_state <> 'receipt_alert_open'
                   AND cardinality(s.blocking_alerts) > 0 THEN 'receipt_alert_open' END,
         CASE WHEN s.paid_out AND s.paid_amount IS NOT NULL AND s.paid_amount <> s.amount THEN 'paid_amount_differs' END,
         CASE WHEN s.paid_out AND NOT s.receipt_verified
                   AND length(COALESCE(s.payout_reference, '')) NOT IN (11, 12) THEN 'reference_unusable' END,
         CASE WHEN s.paid_out AND NOT s.receipt_verified AND r2.ref_payouts > 1 THEN 'shared_reference' END
       ]::text[], NULL) AS exceptions
  FROM st s JOIN rc r2 ON r2.payout_id = s.payout_id
)
SELECT ex.*,
       ex.exceptions[1] AS exception,
       (ex.exceptions && ARRAY['failed_but_paid', 'completed_without_payout', 'landlord_receipt_reversed', 'receipt_contradicts', 'receipt_unreadable', 'receipt_incomplete', 'receipt_reference_differs', 'receipt_amount_differs', 'receipt_duplicate', 'receipt_alert_open', 'paid_amount_differs', 'reference_unusable', 'shared_reference']::text[]) AS under_review,
       CASE WHEN ex.state = 'paid_unconfirmed' THEN
              CASE WHEN ex.exceptions && ARRAY['failed_but_paid', 'completed_without_payout', 'landlord_receipt_reversed', 'receipt_contradicts', 'receipt_unreadable', 'receipt_incomplete', 'receipt_reference_differs', 'receipt_amount_differs', 'receipt_duplicate', 'receipt_alert_open', 'paid_amount_differs', 'reference_unusable', 'shared_reference']::text[] THEN 'under_review' ELSE 'awaiting_receipt' END
       END AS payable_class,
       -- Owed to the landlord outside every weekly float, so the payables list carries it on its own until a payout is
       -- paid out (and, inside the float rules, verified). A payout is paid only when the Receipt Archive verifies it; a
       -- failed attempt proves only that the money did not arrive. Two cases (no_float_basis):
       --   approved_unpaid       an approval still in flight (not completed, not failed)
       --   attempt_ended_unpaid  the LAST attempt on a rent request still funded or repaying, whose agent allocation is
       --                         still open, ended (failed, or marked completed) with no payment; no other attempt on the
       --                         request is paid out, in a weekly float or still in flight. One line per rent request.
       nf.basis IS NOT NULL AS approved_no_float,
       nf.basis AS no_float_basis
  FROM ex
  LEFT JOIN LATERAL (
    SELECT CASE
             WHEN COALESCE(ex.payout_status, '') NOT IN ('completed', 'failed') THEN 'approved_unpaid'
             WHEN EXISTS (SELECT 1 FROM public.rent_requests rq
                           WHERE rq.id = ex.rent_request_id AND rq.status IN ('funded', 'repaying'))
              AND EXISTS (SELECT 1 FROM public.agent_landlord_float_allocations aa
                           WHERE aa.rent_request_id = ex.rent_request_id AND aa.status = 'open')
              AND NOT EXISTS (SELECT 1 FROM ex e2
                               WHERE e2.rent_request_id = ex.rent_request_id AND e2.payout_id <> ex.payout_id
                                 AND (e2.paid_out OR e2.has_weekly_float
                                      OR COALESCE(e2.payout_status, '') NOT IN ('completed', 'failed')
                                      OR (e2.created_at, e2.payout_id) > (ex.created_at, ex.payout_id)))
             THEN 'attempt_ended_unpaid'
           END AS basis
     WHERE NOT ex.paid_out AND NOT ex.has_weekly_float
  ) nf ON true;

-- 2. One row per weekly landlord float: allowance, verified and unverified payouts, the outstanding payable.
CREATE OR REPLACE VIEW public.v_landlord_float_payables AS
WITH fl AS (                     -- the CFO's current weekly landlord float, one per week
  SELECT DISTINCT ON (b.period_start) b.id AS float_id, b.period_start AS week_start, b.period_end AS week_end, b.amount AS float_set, b.created_at
    FROM public.landlord_float_budgets b
   WHERE b.period_type = 'weekly' AND b.superseded_at IS NULL
   ORDER BY b.period_start, b.created_at DESC, b.id
),
al AS (                          -- approvals against each float (live allocations); miscellaneous = CFO-approved above the cap
  SELECT a.week_start, a.rent_request_id, a.kind, a.amount
    FROM public.landlord_float_budget_allocations a
   WHERE a.released_at IS NULL
),
paid_rr AS (                     -- rent requests whose landlord payout has been paid out
  SELECT DISTINCT s.rent_request_id FROM public.v_landlord_payout_settlement s WHERE s.paid_out AND s.rent_request_id IS NOT NULL
),
agg_al AS (
  SELECT al.week_start,
         COALESCE(sum(al.amount) FILTER (WHERE al.kind = 'within_cap'), 0)    AS within_cap_approved,
         COALESCE(sum(al.amount) FILTER (WHERE al.kind = 'miscellaneous'), 0) AS misc_approved,
         count(*)                                                             AS approved_count,
         COALESCE(sum(al.amount) FILTER (WHERE p.rent_request_id IS NULL), 0)  AS approved_not_paid,
         count(*) FILTER (WHERE p.rent_request_id IS NULL)                    AS approved_not_paid_count
    FROM al LEFT JOIN paid_rr p ON p.rent_request_id = al.rent_request_id
   GROUP BY al.week_start
),
agg_pay AS (                     -- landlord payouts made against each float, by Receipt Archive verification
  SELECT s.float_week_start AS week_start,
         COALESCE(sum(s.amount) FILTER (WHERE s.state = 'confirmed'), 0)        AS verified_paid,
         count(*) FILTER (WHERE s.state = 'confirmed')                          AS verified_count,
         COALESCE(sum(s.amount) FILTER (WHERE s.state = 'paid_unconfirmed'), 0) AS unverified_paid,
         count(*) FILTER (WHERE s.state = 'paid_unconfirmed')                   AS unverified_count
    FROM public.v_landlord_payout_settlement s
   WHERE s.has_weekly_float
   GROUP BY s.float_week_start
)
SELECT fl.float_id, fl.week_start, fl.week_end, fl.float_set,
       COALESCE(a.misc_approved, 0)                               AS misc_approved,
       fl.float_set + COALESCE(a.misc_approved, 0)                 AS allowance,
       COALESCE(a.within_cap_approved, 0)                         AS within_cap_approved,
       COALESCE(a.approved_count, 0)                              AS approved_count,
       COALESCE(a.approved_not_paid, 0)                           AS approved_not_paid,
       COALESCE(a.approved_not_paid_count, 0)                     AS approved_not_paid_count,
       COALESCE(p.verified_paid, 0)                               AS verified_paid,
       COALESCE(p.verified_count, 0)                              AS verified_count,
       COALESCE(p.unverified_paid, 0)                             AS unverified_paid,
       COALESCE(p.unverified_count, 0)                            AS unverified_count,
       -- The payable while the week is open: the allowance (float + CFO-approved miscellaneous) less payouts the Receipt
       -- Archive has verified; paid-out but unverified payouts stay inside it. After the week ends (CFO decision 2026-10-21)
       -- nothing more can be approved against it and nothing rolls over, so only the approvals not yet verified stay payable;
       -- the unused allowance lapses (lapsed_unused) and is never payable.
       CASE WHEN fl.week_end >= (now() AT TIME ZONE 'Africa/Kampala')::date
            THEN GREATEST(fl.float_set + COALESCE(a.misc_approved, 0) - COALESCE(p.verified_paid, 0), 0)
            ELSE GREATEST(COALESCE(a.within_cap_approved, 0) + COALESCE(a.misc_approved, 0) - COALESCE(p.verified_paid, 0), 0)
       END                                                                                     AS outstanding_amount,
       (COALESCE(p.verified_paid, 0) > fl.float_set + COALESCE(a.misc_approved, 0))           AS overspent,
       GREATEST(COALESCE(p.verified_paid, 0) - fl.float_set - COALESCE(a.misc_approved, 0), 0) AS overspent_amount,
       fl.week_end < (now() AT TIME ZONE 'Africa/Kampala')::date                               AS week_ended,
       -- approvals (within the cap + miscellaneous) not yet verified: the actual open obligation, open week or ended
       GREATEST(COALESCE(a.within_cap_approved, 0) + COALESCE(a.misc_approved, 0) - COALESCE(p.verified_paid, 0), 0) AS open_obligation,
       CASE WHEN fl.week_end >= (now() AT TIME ZONE 'Africa/Kampala')::date THEN 0
            ELSE GREATEST(fl.float_set + COALESCE(a.misc_approved, 0)
                          - GREATEST(COALESCE(a.within_cap_approved, 0) + COALESCE(a.misc_approved, 0), COALESCE(p.verified_paid, 0)), 0)
       END                                                                                     AS lapsed_unused,
       fl.created_at
  FROM fl
  LEFT JOIN agg_al a ON a.week_start = fl.week_start
  LEFT JOIN agg_pay p ON p.week_start = fl.week_start;

-- 3. The payables list: Supporter Returns, the landlord float payout budget, agent commission payouts and
--    departmental budgets. Kept branches are verbatim; out-of-scope branches are removed.
CREATE OR REPLACE VIEW public.v_payables_lines AS
 SELECT 'partner'::text AS category_key,
    'Supporter Returns & Capital'::text AS category_label,
    'supporter_returns'::text AS product_key,
    'Supporter Returns Due'::text AS product_label,
    'investor_portfolios'::text AS source_table,
    ip.id AS item_id,
    ip.investor_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown supporter'::text) AS counterparty_name,
    GREATEST(round(COALESCE(ip.investment_amount, 0::numeric) * COALESCE(ip.roi_percentage, 0::numeric) / 100.0, 2), 0::numeric) AS outstanding_amount,
    ip.next_roi_date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    ip.status,
    ip.created_at
   FROM investor_portfolios ip
     LEFT JOIN profiles p ON p.id = ip.investor_id
  WHERE ip.status = 'active'::text AND ip.next_roi_date IS NOT NULL AND (COALESCE(ip.investment_amount, 0::numeric) * COALESCE(ip.roi_percentage, 0::numeric)) > 0::numeric
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Float Payout Budget'::text AS category_label,
    CASE WHEN f.overspent THEN 'landlord_float_overspent'::text ELSE 'landlord_float_budget'::text END AS product_key,
    CASE WHEN f.overspent THEN 'Landlord float — overspent (verified payouts above the float)'::text
         ELSE 'Weekly Landlord Float Budget'::text END AS product_label,
    'landlord_float_budgets'::text AS source_table,
    f.float_id AS item_id,
    NULL::uuid AS counterparty_id,
    ('Landlord float, week of '::text || to_char(f.week_start::timestamp without time zone, 'DD Mon YYYY'::text)) AS counterparty_name,
    f.outstanding_amount,
    f.week_end AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    CASE WHEN f.overspent THEN 'overspent'::text
         WHEN f.week_ended THEN 'week_ended'::text
         WHEN f.unverified_count > 0 THEN 'receipts_pending'::text
         ELSE 'open'::text END AS status,
    f.created_at
   FROM public.v_landlord_float_payables f
  -- Each weekly landlord float is payable until landlord payouts made against it are verified by the Receipt Archive.
  WHERE f.outstanding_amount > 0::numeric OR f.overspent
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Float Payout Budget'::text AS category_label,
    'landlord_approved_no_float'::text AS product_key,
    'Landlord payouts approved outside a weekly float'::text AS product_label,
    'landlord_payouts'::text AS source_table,
    s.payout_id AS item_id,
    s.landlord_id AS counterparty_id,
    COALESCE(s.landlord_name, 'Unknown landlord'::text) AS counterparty_name,
    s.amount AS outstanding_amount,
    (s.created_at AT TIME ZONE 'Africa/Kampala'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    CASE WHEN s.no_float_basis = 'attempt_ended_unpaid' AND s.payout_status = 'failed' THEN 'payout_failed_unpaid'::text
         WHEN s.no_float_basis = 'attempt_ended_unpaid' THEN 'completed_without_payment'::text
         ELSE s.payout_status END AS status,
    s.created_at
   FROM public.v_landlord_payout_settlement s
  -- Approved, not yet paid out, in no weekly float (including a rent request whose last payout attempt failed with no
  -- payment): owed, and in no float's payable. Leaves the list once a payout is paid out.
  WHERE s.approved_no_float AND s.amount > 0::numeric
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Payables'::text AS category_label,
    'agent_commission_payout'::text AS product_key,
    'Agent Commission Payouts'::text AS product_label,
    'agent_commission_payouts'::text AS source_table,
    cp.id AS item_id,
    cp.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(cp.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (cp.requested_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    cp.status,
    cp.created_at
   FROM agent_commission_payouts cp
     LEFT JOIN profiles p ON p.id = cp.agent_id
  WHERE (cp.status = ANY (ARRAY['pending'::text, 'approved'::text])) AND COALESCE(cp.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'budget'::text AS category_key,
    'Departmental Budgets'::text AS category_label,
    CASE WHEN b.overspent THEN 'department_budget_overspent'::text ELSE 'department_budget'::text END AS product_key,
    CASE WHEN b.overspent THEN 'Departmental Budgets — overspent (credited above budget)'::text
         ELSE 'Departmental Weekly Budgets'::text END AS product_label,
    'budget_submission_lines'::text AS source_table,
    b.line_id AS item_id,
    b.department_id AS counterparty_id,
    COALESCE(b.department_name, 'Unknown department'::text) AS counterparty_name,
    b.outstanding_amount,
    b.period_end AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    CASE WHEN b.overspent THEN 'overspent'::text
         WHEN b.unproven_credit_amount > 0::numeric THEN 'credit_unproven'::text
         ELSE b.submission_status END AS status,
    b.line_created_at AS created_at
   FROM public.v_budget_payables_lines b
  -- B3: an overspent line stays on the report (amount 0, its own product and status) instead of vanishing.
  WHERE b.outstanding_amount > 0::numeric OR b.overspent;

-- 4. Paid history for the same categories; landlord payouts verified by the Receipt Archive, dated by the payout record.
CREATE OR REPLACE VIEW public.v_payables_payment_history AS
 SELECT 'partner'::text AS category_key,
    'supporter_returns'::text AS product_key,
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'roi_expense'::text
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'landlord_payout'::text AS product_key,
    s.paid_date AS d,
    COALESCE(s.amount, 0::numeric) AS amount
   FROM public.v_landlord_payout_settlement s
  -- Paid = verified by the Receipt Archive, dated by the payout record (never the receipt upload time).
  WHERE s.state = 'confirmed'::text
UNION ALL
 SELECT 'agent'::text AS category_key,
    'agent_commission_payout'::text AS product_key,
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'agent_commission_payable'::text
UNION ALL
 SELECT 'budget'::text AS category_key,
    'department_budget'::text AS product_key,
    (w.credited_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(w.amount, 0::numeric) AS amount
   FROM public.requisition_wallet_credits w
  WHERE w.status = 'credited'::text AND w.credited_at IS NOT NULL
    -- B1: only credits the wallet ledger proves count as paid
    AND NULLIF(w.wallet_transaction_id, ''::text) IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.general_ledger g
                 WHERE g.reference_id = w.wallet_transaction_id AND g.ledger_scope = 'wallet'::text
                   AND g.direction = 'cash_in'::text AND g.user_id = w.user_id AND abs(g.amount - w.amount) < 1::numeric)
    AND EXISTS (SELECT 1 FROM public.v_budget_payables_lines b
                 WHERE b.line_id = CASE w.source_table
                   WHEN 'staff_requisitions'    THEN (SELECT s.budget_line_id FROM public.staff_requisitions s    WHERE s.id = w.requisition_id)
                   WHEN 'employee_requisitions' THEN (SELECT e.budget_line_id FROM public.employee_requisitions e WHERE e.id = w.requisition_id)
                   WHEN 'director_requisitions' THEN (SELECT d.budget_line_id FROM public.director_requisitions d WHERE d.id = w.requisition_id)
                 END);

-- 5. The categories the payables reporting functions group by: the four payables (and 'other').
CREATE OR REPLACE FUNCTION public.payables_category_frame()
 RETURNS TABLE(category_key text, category_label text, sort_order integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT * FROM (VALUES
    ('partner','Supporter Returns & Capital',1),
    ('landlord','Landlord Float Payout Budget',2),
    ('agent','Agent Commissions',3),
    ('budget','Departmental Budgets',4),
    ('other','Unclassified / Other',5)
  ) f(category_key, category_label, sort_order)
$function$;

-- 6. The CFO weekly view (and, with p_week_start, that week's payouts).
CREATE OR REPLACE FUNCTION public.get_landlord_payables_by_week(p_week_start date DEFAULT NULL, p_weekly_float boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  PERFORM public.payables_guard();
  -- The landlord PAYABLE is each weekly float's outstanding allowance (v_landlord_float_payables) plus approved payouts
  -- not yet paid out that sit in no weekly float (approved_no_float): landlord_payable = float_payable + approved_no_float.
  -- Landlord payouts are in exactly ONE group: confirmed + in_float_unverified + historical_review + review_only +
  -- not_paid = all payouts. in_float_unverified payouts are already inside their float's payable: never add them to it.
  WITH s0 AS MATERIALIZED (
    SELECT s.*,
           CASE WHEN s.state = 'confirmed' THEN 'confirmed'
                WHEN s.state = 'paid_unconfirmed' THEN 'in_float_unverified'
                WHEN s.state = 'historical_review' THEN 'historical_review'
                WHEN s.under_review THEN 'review_only'
                ELSE 'not_paid' END AS grp
      FROM public.v_landlord_payout_settlement s),
  f0 AS MATERIALIZED (SELECT * FROM public.v_landlord_float_payables)
  SELECT jsonb_build_object(
    'as_at', now(),
    'rule', 'The landlord payable is each weekly landlord float the CFO sets (plus CFO-approved miscellaneous approvals above it), less landlord payouts made against it that the Receipt Archive has verified. A payout is verified only when its completed withdrawal has an archived, accessible receipt whose latest machine check of that exact file is a match, with the transaction ID (11 or 12 digits) and amount read from it equal to the withdrawal and payout, used by no other payout, with no blocking alert. SMS and provider statements never verify. After a float''s week ends its unused allowance lapses (lapsed_unused, never payable) and only approved payouts not yet verified stay payable. Payouts approved but not yet paid out that sit in no weekly float are payable on their own (approved_no_float) until paid out; landlord_payable = float_payable + approved_no_float. A failed payout attempt is not a payment: while its rent request is still funded or repaying and its agent allocation open, the last attempt stays payable (no_float_basis attempt_ended_unpaid, counted under retry_due) until a payout is made. Payouts paid without a weekly float and not verified are historical review items, outside the payable. Groups never overlap.',
    'totals', jsonb_build_object(
        'float_payable', (SELECT COALESCE(sum(outstanding_amount), 0) FROM f0),
        'floats', (SELECT count(*) FROM f0),
        'floats_open', (SELECT count(*) FROM f0 WHERE outstanding_amount > 0 OR overspent),
        'float_set', (SELECT COALESCE(sum(float_set), 0) FROM f0),
        'misc_approved', (SELECT COALESCE(sum(misc_approved), 0) FROM f0),
        'allowance', (SELECT COALESCE(sum(allowance), 0) FROM f0),
        'verified_paid', (SELECT COALESCE(sum(verified_paid), 0) FROM f0),
        'unverified_paid', (SELECT COALESCE(sum(unverified_paid), 0) FROM f0),
        'approved_not_paid', (SELECT COALESCE(sum(approved_not_paid), 0) FROM f0),
        'overspent_floats', (SELECT count(*) FROM f0 WHERE overspent),
        'overspent_amount', (SELECT COALESCE(sum(overspent_amount), 0) FROM f0),
        'floats_ended', (SELECT count(*) FROM f0 WHERE week_ended),
        'open_obligation', (SELECT COALESCE(sum(open_obligation), 0) FROM f0),
        'lapsed_unused', (SELECT COALESCE(sum(lapsed_unused), 0) FROM f0),
        'payouts', (SELECT count(*) FROM s0), 'payouts_amount', (SELECT COALESCE(sum(amount), 0) FROM s0),
        'confirmed', (SELECT COALESCE(sum(amount), 0) FROM s0 WHERE grp = 'confirmed'),
        'confirmed_count', (SELECT count(*) FROM s0 WHERE grp = 'confirmed'),
        'confirmed_flagged_count', (SELECT count(*) FROM s0 WHERE grp = 'confirmed' AND under_review),
        'in_float_unverified', (SELECT COALESCE(sum(amount), 0) FROM s0 WHERE grp = 'in_float_unverified'),
        'in_float_unverified_count', (SELECT count(*) FROM s0 WHERE grp = 'in_float_unverified'),
        'in_float_under_review_count', (SELECT count(*) FROM s0 WHERE grp = 'in_float_unverified' AND under_review),
        'historical_review', (SELECT COALESCE(sum(amount), 0) FROM s0 WHERE grp = 'historical_review'),
        'historical_review_count', (SELECT count(*) FROM s0 WHERE grp = 'historical_review'),
        'review_only', (SELECT COALESCE(sum(amount), 0) FROM s0 WHERE grp = 'review_only'),
        'review_only_count', (SELECT count(*) FROM s0 WHERE grp = 'review_only'),
        'not_paid', (SELECT COALESCE(sum(amount), 0) FROM s0 WHERE grp = 'not_paid'),
        'not_paid_count', (SELECT count(*) FROM s0 WHERE grp = 'not_paid'),
        'approved_no_float', (SELECT COALESCE(sum(amount), 0) FROM s0 WHERE approved_no_float),
        'approved_no_float_count', (SELECT count(*) FROM s0 WHERE approved_no_float),
        'retry_due', (SELECT COALESCE(sum(amount), 0) FROM s0 WHERE no_float_basis = 'attempt_ended_unpaid'),
        'retry_due_count', (SELECT count(*) FROM s0 WHERE no_float_basis = 'attempt_ended_unpaid'),
        'landlord_payable', (SELECT COALESCE(sum(outstanding_amount), 0) FROM f0)
                            + (SELECT COALESCE(sum(amount), 0) FROM s0 WHERE approved_no_float),
        'exception_count', (SELECT count(*) FROM s0 WHERE under_review)),
    'floats', (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.week_start DESC), '[]'::jsonb) FROM f0 f),
    'historical_by_week', (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.week_start DESC), '[]'::jsonb) FROM (
        SELECT report_week_start AS week_start, count(*) AS payouts, sum(amount) AS amount,
               count(*) FILTER (WHERE under_review) AS flagged
          FROM s0 WHERE grp = 'historical_review' GROUP BY 1) h),
    'receipt_states', (SELECT COALESCE(jsonb_object_agg(k, x), '{}'::jsonb) FROM (
        SELECT grp || ':' || COALESCE(receipt_state, 'not_paid_out') AS k,
               jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount), 0)) AS x
          FROM s0 GROUP BY 1) q),
    'exceptions', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'payout_id', s.payout_id, 'landlord', s.landlord_name, 'amount', s.amount, 'paid_date', s.paid_date,
          'paid_date_source', s.paid_date_source, 'payout_status', s.payout_status, 'state', s.state, 'group', s.grp,
          'float_week_start', s.float_week_start, 'exception', s.exception, 'exceptions', to_jsonb(s.exceptions),
          'receipt_state', s.receipt_state, 'paid_amount', s.paid_amount, 'payout_reference', s.payout_reference,
          'receipt_token', s.receipt_token, 'receipt_check_result', s.receipt_check_result, 'receipt_check_code', s.receipt_check_code,
          'receipt_tid_read', s.receipt_tid_read, 'receipt_amount_read', s.receipt_amount_read,
          'receipt_uploaded_at', s.receipt_uploaded_at, 'blocking_alerts', to_jsonb(s.blocking_alerts),
          'landlord_receipt_number', s.landlord_receipt_number, 'landlord_receipt_status', s.landlord_receipt_status,
          'landlord_receipt_reversed_at', s.landlord_receipt_reversed_at)
          ORDER BY s.paid_at DESC NULLS LAST), '[]'::jsonb)
        FROM s0 s WHERE s.under_review),
    'evidence', jsonb_build_object(
        'source', 'Receipt Archive (withdrawal_requests receipts, payout_proof_ocr_log, payout_proof_integrity_alerts)',
        'receipts_verified', (SELECT count(*) FROM s0 WHERE receipt_verified),
        'receipts_unchecked', (SELECT count(*) FROM s0 WHERE receipt_state = 'receipt_unchecked'),
        'last_receipt_uploaded_at', (SELECT max(receipt_uploaded_at) FROM s0)),
    'lines', CASE WHEN p_week_start IS NULL THEN NULL ELSE
        (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.paid_at DESC NULLS LAST), '[]'::jsonb)
           FROM s0 s
          WHERE s.report_week_start = p_week_start
            AND (p_weekly_float IS NULL OR s.has_weekly_float = p_weekly_float)) END
  ) INTO v;
  RETURN v;
END;
$function$;

-- 7. The payables forecast: new obligations are modelled only for the categories still on the payables list
--    (Supporter Returns, agent commissions); no landlord run-off stream (the float line is scheduled at its week end);
--    each period and the whole horizon say which weeks have a weekly landlord float and which are NOT estimated, and
--    historical-review payouts are reported beside it. Otherwise production's definition, verbatim; grants are kept.
CREATE OR REPLACE FUNCTION public.get_payables_predictive_forecast(p_granularity text DEFAULT 'month'::text, p_periods integer DEFAULT 12, p_as_at date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gran text := lower(COALESCE(p_granularity, 'month'));
  v_periods integer := LEAST(GREATEST(COALESCE(p_periods, 12), 1), 60);
  v_today date := COALESCE(p_as_at, (now() AT TIME ZONE 'Africa/Nairobi')::date);
  v_result jsonb;
BEGIN
  PERFORM payables_guard();
  IF v_gran NOT IN ('day','week','month','quarter','year') THEN
    v_gran := 'month';
  END IF;

WITH params AS (
  SELECT v_gran AS gran, v_periods AS periods, v_today AS today, 365 AS lookback,
         CASE v_gran WHEN 'day' THEN interval '1 day' WHEN 'week' THEN interval '1 week'
              WHEN 'month' THEN interval '1 month' WHEN 'quarter' THEN interval '3 months'
              ELSE interval '1 year' END AS step,
         CASE v_gran WHEN 'day' THEN v_today
              WHEN 'week' THEN date_trunc('week', v_today)::date
              WHEN 'month' THEN date_trunc('month', v_today)::date
              WHEN 'quarter' THEN date_trunc('quarter', v_today)::date
              ELSE date_trunc('year', v_today)::date END AS base
), hist AS (
  SELECT h.category_key ck, h.product_key pk, h.d, SUM(h.amount) amt
  FROM v_payables_payment_history h CROSS JOIN params p
  WHERE h.d IS NOT NULL AND h.d > p.today - p.lookback AND h.d <= p.today AND h.amount > 0
  GROUP BY 1,2,3
), span AS (
  -- Payables scope (CFO, 2026-10-21): no landlord run-off stream. The landlord payable is the weekly float line, carried
  -- at its scheduled date; landlord payment history stays in 'history' (actual payments) only.
  SELECT ck, pk, MIN(d) first_d, COUNT(*) sample_days FROM hist WHERE ck <> 'landlord' GROUP BY 1,2
), dense AS (
  SELECT s.ck, s.pk, g::date d, COALESCE(h.amt,0) amt
  FROM span s CROSS JOIN params p
  CROSS JOIN LATERAL generate_series(s.first_d, p.today, interval '1 day') g
  LEFT JOIN hist h ON h.ck = s.ck AND h.pk = s.pk AND h.d = g::date
), lvl AS (
  SELECT d.ck, d.pk,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.amt) FILTER (WHERE d.d > p.today - 28) AS level_recent,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.amt) FILTER (WHERE d.d > p.today - 42 AND d.d <= p.today - 14) AS level_prior,
    SUM(d.amt) FILTER (WHERE d.d > p.today - 14) AS holdout_actual
  FROM dense d CROSS JOIN params p GROUP BY 1,2
), slope AS (
  SELECT ck, pk, regr_slope(wk_amt, wk_idx) / 7.0 AS slope_per_day
  FROM (SELECT d.ck, d.pk, (d.d - p.today)/7 AS wk_idx, SUM(d.amt) wk_amt
        FROM dense d CROSS JOIN params p GROUP BY 1,2,3) w
  GROUP BY 1,2
), dowf AS (
  SELECT w.ck, w.pk, w.dw,
    CASE WHEN l.level_recent > 0 THEN LEAST(2.5, GREATEST(0.1, w.med_dow / l.level_recent)) ELSE 1 END AS f
  FROM (SELECT d.ck, d.pk, EXTRACT(dow FROM d.d)::int dw,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY d.amt) AS med_dow
        FROM dense d CROSS JOIN params p WHERE d.d > p.today - 84 GROUP BY 1,2,3) w
  JOIN lvl l ON l.ck=w.ck AND l.pk=w.pk
), model AS (
  SELECT s.ck, s.pk, s.sample_days, (p.today - s.first_d + 1) AS lookback_days,
    COALESCE(l.level_recent,0) AS level,
    COALESCE(sl.slope_per_day,0) AS slope_per_day,
    CASE WHEN COALESCE(l.holdout_actual,0) > 0
      THEN LEAST(1.5, ABS(COALESCE(l.level_prior,0)*14 - l.holdout_actual) / l.holdout_actual)
      ELSE NULL END AS mape,
    CASE WHEN s.sample_days < 8 OR COALESCE(l.level_recent,0) <= 0 THEN 'insufficient_data'
         WHEN s.sample_days < 21 THEN 'robust_level'
         WHEN s.sample_days < 60 THEN 'level_plus_trend'
         ELSE 'seasonal_level_trend' END AS method
  FROM span s CROSS JOIN params p
  LEFT JOIN lvl l ON l.ck=s.ck AND l.pk=s.pk
  LEFT JOIN slope sl ON sl.ck=s.ck AND sl.pk=s.pk
), labels AS (
  -- one label per (category, product): the period totals join here, so a second label must never duplicate a row
  SELECT DISTINCT ON (category_key, product_key) category_key ck, category_label cl, product_key pk, product_label pl
    FROM v_payables_lines ORDER BY category_key, product_key, product_label
), outs AS (
  SELECT category_key ck, product_key pk, ROUND(SUM(outstanding_amount),2) outstanding
  FROM v_payables_lines GROUP BY 1,2
), orig_raw AS (
  -- New obligations created, per day, from the obligation tables themselves
  -- Payables scope (CFO, 2026-10-21): only Supporter Returns and agent commissions originate here. Withdrawal
  -- requests and payroll are no longer payables; the landlord payable is the weekly float line (scheduled at the end of
  -- its week below), so per-payout landlord originations would count it twice.
  SELECT 'agent'::text ck, 'agent_commission_payout'::text pk,
         (cp.created_at AT TIME ZONE 'Africa/Nairobi')::date d, COALESCE(cp.amount,0)::numeric amt
  FROM agent_commission_payouts cp
  WHERE cp.status <> 'rejected'
  UNION ALL
  SELECT 'partner','supporter_returns',(g.transaction_date AT TIME ZONE 'Africa/Nairobi')::date, COALESCE(g.amount,0)
  FROM general_ledger g
  WHERE g.category = 'roi_accrued'
), orig_hist AS (
  SELECT o.ck, o.pk, o.d, SUM(o.amt) amt
  FROM orig_raw o CROSS JOIN params p
  WHERE o.d IS NOT NULL AND o.d > p.today - p.lookback AND o.d <= p.today AND o.amt > 0
  GROUP BY 1,2,3
), orig_span AS (
  SELECT ck, pk, MIN(d) first_d, COUNT(*) sample_days FROM orig_hist GROUP BY 1,2
), orig_dense AS (
  SELECT s.ck, s.pk, g::date d, COALESCE(h.amt,0) amt
  FROM orig_span s CROSS JOIN params p
  CROSS JOIN LATERAL generate_series(s.first_d, p.today, interval '1 day') g
  LEFT JOIN orig_hist h ON h.ck = s.ck AND h.pk = s.pk AND h.d = g::date
), orig_lvl AS (
  SELECT d.ck, d.pk,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.amt) FILTER (WHERE d.d > p.today - 28) AS level_recent,
    AVG(d.amt) FILTER (WHERE d.d > p.today - 28) AS mean_recent
  FROM orig_dense d CROSS JOIN params p GROUP BY 1,2
), orig_slope AS (
  SELECT ck, pk, regr_slope(wk_amt, wk_idx) / 7.0 AS slope_per_day
  FROM (SELECT d.ck, d.pk, (d.d - p.today)/7 AS wk_idx, SUM(d.amt) wk_amt
        FROM orig_dense d CROSS JOIN params p GROUP BY 1,2,3) w
  GROUP BY 1,2
), orig_totals AS (
  SELECT ck, pk, SUM(amt) AS originated_lookback FROM orig_hist GROUP BY 1,2
), paid_totals AS (
  SELECT ck, pk, SUM(amt) AS paid_lookback FROM hist GROUP BY 1,2
), orig_model AS (
  SELECT s.ck, s.pk, s.sample_days,
    GREATEST(COALESCE(l.level_recent,0), COALESCE(l.mean_recent,0) * 0.5) AS level,
    COALESCE(sl.slope_per_day,0) AS slope_per_day,
    LEAST(1.0, GREATEST(0.05,
      COALESCE(pt.paid_lookback,0) / NULLIF(ot.originated_lookback,0)
    )) AS payment_rate,
    LEAST(730, GREATEST(7,
      COALESCE(o.outstanding,0) / NULLIF(GREATEST(m.level, 1), 0)
    )) AS term_days,
    CASE WHEN s.sample_days < 8 THEN 'insufficient_data'
         WHEN s.sample_days < 21 THEN 'robust_level'
         ELSE 'level_plus_trend' END AS method
  FROM orig_span s
  LEFT JOIN orig_lvl l ON l.ck=s.ck AND l.pk=s.pk
  LEFT JOIN orig_slope sl ON sl.ck=s.ck AND sl.pk=s.pk
  LEFT JOIN orig_totals ot ON ot.ck=s.ck AND ot.pk=s.pk
  LEFT JOIN paid_totals pt ON pt.ck=s.ck AND pt.pk=s.pk
  LEFT JOIN outs o ON o.ck=s.ck AND o.pk=s.pk
  LEFT JOIN model m ON m.ck=s.ck AND m.pk=s.pk
), periods AS (
  SELECT i,
    (p.base + (p.step * i))::date AS period_start,
    ((p.base + (p.step * (i+1))) - interval '1 day')::date AS period_end
  FROM params p CROSS JOIN generate_series(0, p.periods - 1) i
), horizon AS (
  SELECT MIN(GREATEST(period_start, (SELECT today FROM params))) f, MAX(period_end) t FROM periods
), day_fc AS (
  SELECT m.ck, m.pk, g::date d,
    GREATEST(0::numeric,
      (m.level + m.slope_per_day
        * LEAST(1, GREATEST(0.15, 1 - COALESCE(m.mape, 0.7)))
        * (1.0 / (1 + ((g::date - p.today)::numeric / 365.0)))
        * (g::date - p.today))
      * CASE WHEN m.method = 'seasonal_level_trend' THEN COALESCE(f.f, 1) ELSE 1 END
    ) AS amt
  FROM model m
  CROSS JOIN params p
  CROSS JOIN horizon h
  CROSS JOIN LATERAL generate_series(h.f, h.t, interval '1 day') g
  LEFT JOIN dowf f ON f.ck = m.ck AND f.pk = m.pk AND f.dw = EXTRACT(dow FROM g)::int
  WHERE m.method <> 'insufficient_data'
), day_orig AS (
  SELECT om.ck, om.pk, g::date d,
    GREATEST(0::numeric,
      LEAST(
        om.level * 3.0,
        om.level + om.slope_per_day
          * (1.0 / (1 + ((g::date - p.today)::numeric / 365.0)))
          * (g::date - p.today)
      )
      * om.payment_rate
      * LEAST(1.0, ((g::date - p.today)::numeric + 1) / om.term_days)
    ) AS amt
  FROM orig_model om
  CROSS JOIN params p
  CROSS JOIN horizon h
  CROSS JOIN LATERAL generate_series(h.f, h.t, interval '1 day') g
  WHERE om.method <> 'insufficient_data'
), fc_period AS (
  SELECT pr.i, df.ck, df.pk, ROUND(SUM(df.amt)::numeric,2) amt
  FROM day_fc df JOIN periods pr ON df.d BETWEEN pr.period_start AND pr.period_end
  GROUP BY 1,2,3
), orig_period AS (
  SELECT pr.i, df.ck, df.pk, ROUND(SUM(df.amt)::numeric,2) amt
  FROM day_orig df JOIN periods pr ON df.d BETWEEN pr.period_start AND pr.period_end
  GROUP BY 1,2,3
), fc_split AS (
  SELECT f.*, o.outstanding,
    SUM(f.amt) OVER (PARTITION BY f.ck, f.pk ORDER BY f.i) AS cum
  FROM fc_period f LEFT JOIN outs o ON o.ck=f.ck AND o.pk=f.pk
), fc_final AS (
  SELECT i, ck, pk,
    ROUND(LEAST(cum, COALESCE(outstanding,0)) - LEAST(cum - amt, COALESCE(outstanding,0)), 2) AS runoff
  FROM fc_split
), modelled AS (
  SELECT COALESCE(r.i, o.i) i, COALESCE(r.ck, o.ck) ck, COALESCE(r.pk, o.pk) pk,
    COALESCE(r.runoff,0) AS runoff, COALESCE(o.amt,0) AS new_orig
  FROM fc_final r
  FULL OUTER JOIN orig_period o ON o.i=r.i AND o.ck=r.ck AND o.pk=r.pk
), sched AS (
  -- Payables scope (CFO, 2026-10-21): a scheduled item already past its due date and still outstanding is carried into
  -- the period that contains today (basis 'overdue') until it is settled, so an ended landlord float or a past-due
  -- budget line never drops out of the forecast. Each line lands in exactly one period; zero-value lines are skipped.
  SELECT pr.i, l.category_key ck, l.product_key pk,
         CASE WHEN l.due_date < (SELECT today FROM params) THEN 'overdue' ELSE 'scheduled' END AS basis,
         ROUND(SUM(l.outstanding_amount),2) amt
  FROM v_payables_lines l
  JOIN periods pr ON GREATEST(l.due_date, (SELECT today FROM params))
                     BETWEEN GREATEST(pr.period_start, (SELECT today FROM params)) AND pr.period_end
  WHERE l.due_date IS NOT NULL AND l.outstanding_amount <> 0
    AND NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=l.category_key AND m.pk=l.product_key AND m.method <> 'insufficient_data')
  GROUP BY 1,2,3,4
), combined AS (
  SELECT i, ck, pk, (runoff + new_orig) AS total, runoff, new_orig, 'modelled'::text basis FROM modelled
  UNION ALL
  SELECT i, ck, pk, amt, amt, 0, basis FROM sched
), hist_span AS (
  SELECT GREATEST(1, (SELECT today FROM params) - MIN(d)) AS span_days FROM hist
), per_period AS (
  SELECT c.i, ROUND(SUM(c.total),2) total, ROUND(SUM(c.runoff),2) runoff, ROUND(SUM(c.new_orig),2) new_orig,
    ROUND(COALESCE(SUM(c.total * COALESCE(m.mape, 0.5)::numeric) FILTER (WHERE c.basis='modelled')
      / NULLIF(SUM(c.total) FILTER (WHERE c.basis='modelled'), 0), 0.5)::numeric, 4) AS wmape,
    ROUND(COALESCE(SUM(c.total) FILTER (WHERE c.basis IN ('scheduled','overdue')),0),2) AS scheduled_total,
    ROUND(COALESCE(SUM(c.total) FILTER (WHERE c.basis='overdue'),0),2) AS overdue_total,
    jsonb_agg(jsonb_build_object(
      'category_key', c.ck, 'category_label', COALESCE(lb.cl, c.ck),
      'product_key', c.pk, 'product_label', COALESCE(lb.pl, c.pk),
      'amount', ROUND(c.total,2), 'runoff', ROUND(c.runoff,2),
      'new_origination', ROUND(c.new_orig,2), 'basis', c.basis
    ) ORDER BY c.total DESC) AS sources
  FROM combined c
  LEFT JOIN model m ON m.ck=c.ck AND m.pk=c.pk
  LEFT JOIN labels lb ON lb.ck=c.ck AND lb.pk=c.pk
  GROUP BY c.i
), period_quality AS (
  SELECT pr.i, pr.period_start, pr.period_end, pp.total, pp.runoff, pp.new_orig, pp.wmape,
    pp.scheduled_total, pp.overdue_total, pp.sources, p.today, p.gran, hs.span_days,
    GREATEST(0, pr.period_end - p.today) AS horizon_days,
    CASE
      WHEN pp.total IS NULL THEN 'insufficient'
      WHEN GREATEST(0, pr.period_end - p.today) > COALESCE(hs.span_days,1) * 2
        OR (p.gran = 'year' AND pr.period_start > date_trunc('year', p.today)::date) THEN 'low'
      WHEN GREATEST(0, pr.period_end - p.today) > COALESCE(hs.span_days,1) THEN
        CASE WHEN COALESCE(pp.wmape,1) < 0.4 THEN 'medium' ELSE 'low' END
      WHEN COALESCE(pp.wmape,1) < 0.2 THEN 'high'
      WHEN COALESCE(pp.wmape,1) < 0.4 THEN 'medium'
      ELSE 'low' END AS quality,
    CASE
      WHEN pp.total IS NULL THEN 'no modelled stream has enough history for this period'
      WHEN GREATEST(0, pr.period_end - p.today) > COALESCE(hs.span_days,1) * 2
        OR (p.gran = 'year' AND pr.period_start > date_trunc('year', p.today)::date)
        THEN 'extrapolation far beyond the ' || COALESCE(hs.span_days,0) || ' days of observed payment history - treat as directional only'
      WHEN GREATEST(0, pr.period_end - p.today) > COALESCE(hs.span_days,1)
        THEN 'horizon exceeds the ' || COALESCE(hs.span_days,0) || ' days of observed payment history'
      ELSE 'within observed history span; backtest error ' || ROUND(COALESCE(pp.wmape,0.5)*100,1) || '%' END AS quality_reason
  FROM periods pr CROSS JOIN params p LEFT JOIN hist_span hs ON true
  LEFT JOIN per_period pp ON pp.i = pr.i
), periods_json AS (
  SELECT jsonb_agg(jsonb_build_object(
    'index', q.i,
    'period_start', q.period_start, 'period_end', q.period_end,
    'forecast_from', GREATEST(q.period_start, q.today),
    'is_partial_period', q.period_start < q.today,
    'label', CASE q.gran
        WHEN 'day' THEN to_char(q.period_start,'DD Mon')
        WHEN 'week' THEN 'Wk ' || to_char(q.period_start,'IW YYYY')
        WHEN 'month' THEN to_char(q.period_start,'Mon YYYY')
        WHEN 'quarter' THEN 'Q' || to_char(q.period_start,'Q YYYY')
        ELSE to_char(q.period_start,'YYYY') END,
    'forecast_amount', COALESCE(q.total,0),
    'runoff_amount', COALESCE(q.runoff,0),
    'new_origination_amount', COALESCE(q.new_orig,0),
    'scheduled_amount', COALESCE(q.scheduled_total,0),
    'overdue_carried_amount', COALESCE(q.overdue_total,0),
    'low', ROUND(COALESCE(q.total,0) * (1 - LEAST(0.6, GREATEST(0.1, COALESCE(q.wmape,0.5)))),2),
    'high', ROUND(COALESCE(q.total,0) * (1 + LEAST(0.6, GREATEST(0.1, COALESCE(q.wmape,0.5)))),2),
    'confidence', LEAST(
        CASE q.quality WHEN 'low' THEN 0.35 WHEN 'medium' THEN 0.6 WHEN 'insufficient' THEN 0.05 ELSE 0.95 END,
        ROUND(GREATEST(0.05, LEAST(0.95, (1 - COALESCE(q.wmape,0.5))
          * (1.0 / (1 + q.horizon_days::numeric / 365.0)))),3)),
    'quality', q.quality,
    'quality_reason', q.quality_reason,
    'is_forecast', true,
    'sources', COALESCE(q.sources, '[]'::jsonb),
    'landlord_float', (SELECT jsonb_build_object(
        'weeks', count(*),
        'weeks_with_float', count(lf.week_start),
        'weeks_without_float', COALESCE(jsonb_agg(g.wk::date ORDER BY g.wk) FILTER (WHERE lf.week_start IS NULL), '[]'::jsonb),
        'float_outstanding', COALESCE(sum(lf.outstanding_amount), 0),
        'landlord_not_estimated', COALESCE(bool_or(lf.week_start IS NULL), false))
      FROM generate_series(public.landlord_float_week_start(GREATEST(q.period_start, q.today)), q.period_end, interval '1 week') g(wk)
      LEFT JOIN v_landlord_float_payables lf ON lf.week_start = g.wk::date
     WHERE (g.wk::date + 6) BETWEEN GREATEST(q.period_start, q.today) AND q.period_end)
      || jsonb_build_object('overdue_float_outstanding',
           CASE WHEN q.today BETWEEN q.period_start AND q.period_end
                THEN (SELECT COALESCE(sum(ovf.outstanding_amount), 0) FROM v_landlord_float_payables ovf WHERE ovf.week_end < q.today)
                ELSE 0 END)
  ) ORDER BY q.i) j
  FROM period_quality q
), hist_json AS (
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'period_start')), '[]'::jsonb) j FROM (
    SELECT jsonb_build_object(
      'period_start', bucket, 'label', CASE p.gran
        WHEN 'day' THEN to_char(bucket,'DD Mon') WHEN 'week' THEN 'Wk ' || to_char(bucket,'IW YYYY')
        WHEN 'month' THEN to_char(bucket,'Mon YYYY') WHEN 'quarter' THEN 'Q' || to_char(bucket,'Q YYYY')
        ELSE to_char(bucket,'YYYY') END,
      'actual_amount', ROUND(SUM(amt),2), 'is_forecast', false) x
    FROM (
      SELECT CASE p.gran WHEN 'day' THEN h.d WHEN 'week' THEN date_trunc('week',h.d)::date
                  WHEN 'month' THEN date_trunc('month',h.d)::date
                  WHEN 'quarter' THEN date_trunc('quarter',h.d)::date
                  ELSE date_trunc('year',h.d)::date END AS bucket, h.amt
      FROM hist h CROSS JOIN params p
    ) b CROSS JOIN params p
    GROUP BY bucket, p.gran
    ORDER BY bucket DESC
    LIMIT (SELECT periods FROM params)
  ) s
), actual_json AS (
  SELECT jsonb_build_object(
    'total', ROUND(COALESCE(SUM(outstanding_amount),0),2),
    'item_count', COUNT(*),
    'overdue', ROUND(COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date IS NOT NULL AND due_date < (SELECT today FROM params)),0),2),
    'not_yet_due', ROUND(COALESCE(SUM(outstanding_amount) FILTER (WHERE due_date IS NULL OR due_date >= (SELECT today FROM params)),0),2),
    'categories', COALESCE((SELECT jsonb_agg(jsonb_build_object('category_key',ck,'category_label',cl,'outstanding',amt) ORDER BY amt DESC)
       FROM (SELECT category_key ck, MAX(category_label) cl, ROUND(SUM(outstanding_amount),2) amt
             FROM v_payables_lines GROUP BY 1) c), '[]'::jsonb)
  ) j FROM v_payables_lines
), streams_json AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category_key', m.ck, 'category_label', COALESCE(lb.cl, m.ck),
    'product_key', m.pk, 'product_label', COALESCE(lb.pl, m.pk),
    'method', m.method, 'sample_days', m.sample_days, 'lookback_days', m.lookback_days,
    'median_daily', ROUND(m.level::numeric,2), 'trend_per_week', ROUND((m.slope_per_day * 7)::numeric, 2),
    'backtest_mape', m.mape, 'seasonality_applied', m.method = 'seasonal_level_trend',
    'insufficient_data', m.method = 'insufficient_data',
    'outstanding', COALESCE(o.outstanding, 0),
    'origination', CASE WHEN om.ck IS NULL THEN NULL ELSE jsonb_build_object(
        'method', om.method,
        'sample_days', om.sample_days,
        'daily_new_payables', ROUND(om.level::numeric,2),
        'trend_per_week', ROUND((om.slope_per_day * 7)::numeric,2),
        'payment_rate', ROUND(om.payment_rate::numeric,4),
        'term_days', ROUND(om.term_days::numeric,0)
      ) END
  ) ORDER BY m.level DESC), '[]'::jsonb) j
  FROM model m LEFT JOIN labels lb ON lb.ck=m.ck AND lb.pk=m.pk
  LEFT JOIN outs o ON o.ck=m.ck AND o.pk=m.pk
  LEFT JOIN orig_model om ON om.ck=m.ck AND om.pk=m.pk AND om.method <> 'insufficient_data'
), no_hist AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category_key', o.ck, 'product_key', o.pk,
    'product_label', COALESCE(lb.pl, o.pk), 'outstanding', o.outstanding,
    'reason', 'no payment history - contractual due dates only') ORDER BY o.outstanding DESC), '[]'::jsonb) j
  FROM outs o LEFT JOIN labels lb ON lb.ck=o.ck AND lb.pk=o.pk
  WHERE NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=o.ck AND m.pk=o.pk AND m.method <> 'insufficient_data')
), no_orig AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category_key', o.ck, 'product_key', o.pk,
    'product_label', COALESCE(lb.pl, o.pk), 'outstanding', o.outstanding,
    'reason', 'no obligation-creation history - existing book run-off only, no new obligations forecast'
  ) ORDER BY o.outstanding DESC), '[]'::jsonb) j
  FROM outs o LEFT JOIN labels lb ON lb.ck=o.ck AND lb.pk=o.pk
  WHERE NOT EXISTS (SELECT 1 FROM orig_model om WHERE om.ck=o.ck AND om.pk=o.pk AND om.method <> 'insufficient_data')
)
SELECT jsonb_build_object(
  'currency','UGX',
  'granularity', (SELECT gran FROM params),
  'periods_requested', (SELECT periods FROM params),
  'as_at', (SELECT today FROM params),
  'timezone','Africa/Nairobi',
  'actual', (SELECT j FROM actual_json),
  'history', (SELECT j FROM hist_json),
  'periods', COALESCE((SELECT j FROM periods_json), '[]'::jsonb),
  'streams', (SELECT j FROM streams_json),
  'scheduled_only_streams', (SELECT j FROM no_hist),
  'origination_only_streams', (SELECT j FROM no_orig),
  'meta', jsonb_build_object(
    'history_span_days', (SELECT span_days FROM hist_span),
    'lookback_days', (SELECT lookback FROM params),
    'model_version', 'payables runoff+obligations v1 (2026-08-26)',
    'method_note', 'Two components, both modelled from live history with no hardcoded growth rates. (1) Run-off of the recorded payables book: per-stream robust level (28-day median of actual payments) with weekly OLS trend, damped by holdout error and horizon distance, day-of-week seasonality when >=60 observed days, cumulatively capped at what is actually outstanding. (2) New obligations: per-stream daily new-payable level and weekly trend from the obligation tables, multiplied by the stream''s observed payment rate (paid divided by created over the same lookback) and ramped over its implied settlement term, bounded at 3x the observed level so long horizons cannot run away. Streams with contractual due dates but no payment history are carried at their scheduled amounts. Forecast quality is capped relative to the observed history span, so horizons beyond it can never read as high confidence.',
    'source', 'v_payables_lines + v_payables_payment_history + observed obligation-creation history'
  ),
  'reconciliation', (
    SELECT jsonb_build_object(
             'payables_total', x.total, 'forecast_book_runoff', x.runoff, 'of_which_overdue_carried', x.overdue,
             'modelled_not_run_off_in_horizon', x.not_run_off, 'no_due_date', x.no_due, 'due_after_horizon', x.after_h,
             'new_originations_not_in_list', x.new_orig,
             'difference', x.total - (x.runoff + x.not_run_off + x.no_due + x.after_h))
      FROM (SELECT
              (SELECT ROUND(COALESCE(SUM(outstanding_amount),0),2) FROM v_payables_lines) AS total,
              (SELECT ROUND(COALESCE(SUM(runoff),0),2) FROM per_period) AS runoff,          -- the period totals people see
              (SELECT ROUND(COALESCE(SUM(overdue_total),0),2) FROM per_period) AS overdue,
              (SELECT ROUND(COALESCE(SUM(o.outstanding),0),2) FROM outs o
                WHERE EXISTS (SELECT 1 FROM model m WHERE m.ck=o.ck AND m.pk=o.pk AND m.method <> 'insufficient_data'))
                - (SELECT ROUND(COALESCE(SUM(c.runoff),0),2) FROM combined c WHERE c.basis = 'modelled') AS not_run_off,
              (SELECT ROUND(COALESCE(SUM(l.outstanding_amount),0),2) FROM v_payables_lines l WHERE l.due_date IS NULL
                  AND NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=l.category_key AND m.pk=l.product_key AND m.method <> 'insufficient_data')) AS no_due,
              (SELECT ROUND(COALESCE(SUM(l.outstanding_amount),0),2) FROM v_payables_lines l WHERE l.due_date > (SELECT MAX(period_end) FROM periods)
                  AND NOT EXISTS (SELECT 1 FROM model m WHERE m.ck=l.category_key AND m.pk=l.product_key AND m.method <> 'insufficient_data')) AS after_h,
              (SELECT ROUND(COALESCE(SUM(new_orig),0),2) FROM per_period) AS new_orig) x
  ),
  'landlord_coverage', (
    SELECT jsonb_build_object(
             'basis', 'weekly_landlord_float',
             'note', 'Landlord payables are recorded per weekly landlord float set by the CFO. A week without a weekly float carries no landlord amount in this forecast: its landlord obligations are not estimated, which does not mean there are none. A float whose week has ended stays in the forecast, carried into the current period as overdue, until its payouts are verified or it is otherwise resolved. After a float''s week ends only its approved payouts not yet verified stay payable; its unused allowance lapses (lapsed_unused_float_allowance) and is never payable. Payouts approved but not yet paid out that sit in no weekly float are owed: they are carried on their own (approved_no_float_outstanding) from their approval date until paid out, including a still-funded rent request whose last payout attempt failed (a failed attempt is not a payment). Landlord payouts made without a weekly float and not verified by the Receipt Archive are held for CFO review (historical review) and are outside the payables and this forecast.',
             'weeks_in_horizon', (c.j->>'weeks')::int,
             'weeks_with_float', (c.j->>'weeks_with_float')::int,
             'weeks_without_float', c.j->'weeks_without_float',
             'landlord_not_estimated', (c.j->>'landlord_not_estimated')::boolean,
             'float_outstanding', (c.j->>'float_outstanding')::numeric,
             'historical_review_count', (SELECT count(*) FROM v_landlord_payout_settlement WHERE state = 'historical_review'),
             'historical_review_amount', (SELECT COALESCE(sum(amount), 0) FROM v_landlord_payout_settlement WHERE state = 'historical_review'),
             'overdue_floats', (SELECT COALESCE(jsonb_agg(jsonb_build_object('week_start', ovf.week_start, 'week_end', ovf.week_end,
                                        'outstanding', ovf.outstanding_amount, 'unverified_paid', ovf.unverified_paid) ORDER BY ovf.week_start), '[]'::jsonb)
                                  FROM v_landlord_float_payables ovf WHERE ovf.week_end < (SELECT today FROM params) AND ovf.outstanding_amount > 0),
             'overdue_float_outstanding', (SELECT COALESCE(sum(ovf.outstanding_amount), 0) FROM v_landlord_float_payables ovf
                                            WHERE ovf.week_end < (SELECT today FROM params)),
             'lapsed_unused_float_allowance', (SELECT COALESCE(sum(ovf.lapsed_unused), 0) FROM v_landlord_float_payables ovf),
             'approved_no_float_count', (SELECT count(*) FROM v_landlord_payout_settlement WHERE approved_no_float),
             'approved_no_float_outstanding', (SELECT COALESCE(sum(amount), 0) FROM v_landlord_payout_settlement WHERE approved_no_float))
      FROM (SELECT (SELECT jsonb_build_object(
        'weeks', count(*),
        'weeks_with_float', count(lf.week_start),
        'weeks_without_float', COALESCE(jsonb_agg(g.wk::date ORDER BY g.wk) FILTER (WHERE lf.week_start IS NULL), '[]'::jsonb),
        'float_outstanding', COALESCE(sum(lf.outstanding_amount), 0),
        'landlord_not_estimated', COALESCE(bool_or(lf.week_start IS NULL), false))
      FROM generate_series(public.landlord_float_week_start((SELECT today FROM params)), (SELECT MAX(period_end) FROM periods), interval '1 week') g(wk)
      LEFT JOIN v_landlord_float_payables lf ON lf.week_start = g.wk::date
     WHERE (g.wk::date + 6) BETWEEN (SELECT today FROM params) AND (SELECT MAX(period_end) FROM periods)) j) c
  ),
  'unscheduled', (
    SELECT jsonb_build_object(
             'items',      COALESCE(SUM(c), 0),
             'amount',     COALESCE(SUM(amt), 0),
             'by_product', COALESCE(jsonb_object_agg(product_key, amt), '{}'::jsonb),
             'note',       'Payable on demand. Included in Total Payables, excluded from the forecast timeline: no contractual due date and no daily amount to project from.')
      FROM (SELECT product_key, ROUND(SUM(outstanding_amount), 2) AS amt, COUNT(*) AS c
              FROM v_payables_lines
             WHERE (due_kind = 'projected' AND COALESCE(daily_amount, 0) <= 0)
                OR (due_kind = 'scheduled' AND due_date IS NULL)
             GROUP BY product_key) q
  )
)
  INTO v_result;

  RETURN v_result;
END;
$function$;

-- 8. Grants. Views stay service_role only; the RPC checks roles itself (payables_guard).
REVOKE ALL ON public.v_landlord_payout_settlement FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_landlord_payout_settlement TO service_role;
REVOKE ALL ON public.v_landlord_float_payables FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_landlord_float_payables TO service_role;
REVOKE ALL ON public.v_payables_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_payables_lines TO service_role;
REVOKE ALL ON public.v_payables_payment_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_payables_payment_history TO service_role;
REVOKE ALL ON FUNCTION public.get_landlord_payables_by_week(date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_landlord_payables_by_week(date, boolean) TO authenticated, service_role;

RESET lock_timeout;
