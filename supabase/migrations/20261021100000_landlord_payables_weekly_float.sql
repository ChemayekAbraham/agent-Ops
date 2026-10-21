-- 2026-10-21: landlord payables under the CFO's weekly-float rule (payables part 3) — Receipt Archive evidence.
--
-- Decided by the CFO (2026-10-20/21):
--   * EVIDENCE: the Receipt Archive on the Financial Operations dashboard is the SOLE evidence source (receipt-copy-guard:
--     the archive has been Welile's sole record of payout receipts since 2026-07-16). Provider SMS, provider statements,
--     phone/amount/date matching and probable matches NEVER confirm a payout.
--   * A landlord payout is CONFIRMED only when ALL of these hold:
--       1. it was paid through a completed withdrawal linked by landlord_payout_id;
--       2. that withdrawal has a receipt token and a proof file that exists in storage;
--       3. the latest machine check (payout_proof_ocr_log) of THAT EXACT file is 'match';
--       4. the transaction ID read from the receipt equals the withdrawal reference, and
--       5. is 11 (MTN) or 12 (Airtel) digits (the provider cannot be established reliably, so no provider-specific length);
--       6. the amount read equals the withdrawal amount, which equals the payout amount;
--       7. no other payout or withdrawal has a receipt with that ID or the same reference;
--       8. no open integrity alert makes the receipt unreliable (invalid_storage_reference, missing_storage_object,
--          sms_image_field_mismatch, ...); 'proof_missing' never blocks on its own: it is raised only when no proof was
--          attached, so it is either stale (file now archived) or the same fact as receipt_missing;
--       9. a missing or unreadable ID or amount is never a match.
--   * A paid-out payout that is not confirmed is PAYABLE, split into payable_under_review (an exception) and
--     payable_awaiting_receipt (no archive record, receipt missing, or never machine-checked). Payouts paid BEFORE the
--     archive start (system_config.landlord_receipt_archive_from, default 2026-07-17) that the archive cannot verify
--     are HISTORICAL REVIEW items for the CFO: neither confirmed nor payable.
--   * landlord_receipt_reversed (review flag only): the payout's CURRENT Welile landlord receipt (landlord_payout_receipts,
--     followed through replacements via replaces_receipt_id) is reversed or refunded and has no valid replacement.
--     That receipt is never payment evidence; the flag never changes a group, an amount or a payout.
--   * Groups do not overlap: confirmed + payable + historical_review + review_only + not_paid = all payouts.
--   * Dates: the payout date is the payout record (withdrawal completed, or FinOps disbursement). The receipt upload time
--     is shown only as the receipt upload date; the date read from a receipt image is shown, never used as a payout date.
--   * Payouts are grouped by the CFO weekly landlord float; payouts without one by the week they were paid.
--
-- REPORTING ONLY. No ledger entry, wallet, payout, withdrawal, receipt, allocation or status is written; no OCR or
-- approval is run. Requires 20261020210000_budget_payables (its v_payables_lines / v_payables_payment_history bodies are
-- pinned). The two status-based landlord branches of v_payables_lines and the two ledger-based landlord branches of
-- v_payables_payment_history are replaced; every other branch is verbatim.
-- Rollback: supabase/rollbacks/20261021100000_landlord_payables_weekly_float.rollback.sql
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
  IF to_regclass('public.landlord_payouts') IS NULL OR to_regclass('public.withdrawal_requests') IS NULL
     OR to_regclass('public.payout_proof_ocr_log') IS NULL OR to_regclass('public.payout_proof_integrity_alerts') IS NULL
     OR to_regclass('storage.objects') IS NULL
     OR to_regclass('public.landlord_float_budget_allocations') IS NULL OR to_regclass('public.landlord_float_budgets') IS NULL
     OR to_regclass('public.system_config') IS NULL OR to_regclass('public.profiles') IS NULL
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
            AND column_name IN ('id', 'payout_id', 'receipt_number', 'status', 'reversed_at', 'replaces_receipt_id', 'created_at')) <> 7 THEN
    RAISE EXCEPTION 'precondition failed: a table, column or function this migration depends on is missing';
  END IF;
END
$pre$;

INSERT INTO public.system_config (key, value, updated_at)
VALUES ('landlord_receipt_archive_from', to_jsonb('2026-07-17'::text), now())
ON CONFLICT (key) DO NOTHING;

-- 1. One row per landlord payout: paid out?, which weekly float, its Receipt Archive evidence check by check,
--    the group it belongs to and its exceptions.
CREATE OR REPLACE VIEW public.v_landlord_payout_settlement AS
WITH cfg AS (
  SELECT COALESCE((SELECT (c.value #>> '{}')::date FROM public.system_config c WHERE c.key = 'landlord_receipt_archive_from'),
                  DATE '2026-07-17') AS archive_from
),
wr AS (                          -- the completed withdrawal that paid the landlord: its Receipt Archive record
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
       END AS receipt_state,
       cfg.archive_from
  FROM rc r CROSS JOIN cfg
),
st AS (
SELECT f.*,
       f.receipt_state = 'receipt_verified' AS receipt_verified,
       CASE WHEN f.paid_out AND f.receipt_state = 'receipt_verified' THEN 'confirmed'
            WHEN f.paid_out AND f.paid_date < f.archive_from THEN 'historical_review'
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
       END AS payable_class
  FROM ex;

-- 2. The payables list: every non-landlord branch verbatim (incl. Part 2's budget branch); the two status-based
--    landlord branches become one Receipt-Archive branch (payable only).
CREATE OR REPLACE VIEW public.v_payables_lines AS
SELECT 'user'::text AS category_key,
    'User Wallets & Withdrawals'::text AS category_label,
    'withdrawal_request'::text AS product_key,
    'Withdrawal Requests In Flight'::text AS product_label,
    'withdrawal_requests'::text AS source_table,
    w.id AS item_id,
    w.user_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown user'::text) AS counterparty_name,
    GREATEST(COALESCE(w.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (w.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    w.status,
    w.created_at
   FROM withdrawal_requests w
     LEFT JOIN profiles p ON p.id = w.user_id
  WHERE (w.status = ANY (ARRAY['pending'::text, 'approved'::text, 'processing'::text, 're_approved_for_recovery'::text])) AND COALESCE(w.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'user'::text AS category_key,
    'User Wallets & Withdrawals'::text AS category_label,
    'wallet_balance'::text AS product_key,
    'Withdrawable Wallet Balances'::text AS product_label,
    'wallets'::text AS source_table,
    wl.id AS item_id,
    wl.user_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown user'::text) AS counterparty_name,
    GREATEST(COALESCE(wl.withdrawable_balance, 0::numeric), 0::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    0::numeric AS daily_amount,
    'available'::text AS status,
    wl.created_at
   FROM wallets wl
     LEFT JOIN profiles p ON p.id = wl.user_id
  WHERE COALESCE(wl.withdrawable_balance, 0::numeric) > 0::numeric
UNION ALL
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
    'Landlord Rent Payouts'::text AS category_label,
    'landlord_payout'::text AS product_key,
    'Landlord Payouts — paid out, receipt not yet verified in the Receipt Archive'::text AS product_label,
    'landlord_payouts'::text AS source_table,
    s.payout_id AS item_id,
    s.landlord_id AS counterparty_id,
    COALESCE(NULLIF(s.landlord_name, ''::text), 'Unknown landlord'::text) AS counterparty_name,
    GREATEST(COALESCE(s.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    s.paid_date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    COALESCE(s.exception, s.receipt_state) AS status,
    s.created_at
   FROM public.v_landlord_payout_settlement s
  -- Paid out (after the archive start) and not verified by the Receipt Archive: the landlord payable.
  WHERE s.state = 'paid_unconfirmed'::text AND COALESCE(s.amount, 0::numeric) > 0::numeric
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
 SELECT 'agent'::text AS category_key,
    'Agent Payables'::text AS category_label,
    'agent_float_withdrawal'::text AS product_key,
    'Agent Float Withdrawals In Flight'::text AS product_label,
    'agent_float_withdrawals'::text AS source_table,
    fw.id AS item_id,
    fw.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(fw.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (fw.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    fw.status,
    fw.created_at
   FROM agent_float_withdrawals fw
     LEFT JOIN profiles p ON p.id = fw.agent_id
  WHERE (fw.status = ANY (ARRAY['pending'::text, 'agent_ops_approved'::text, 'manager_approved'::text, 'processing'::text])) AND COALESCE(fw.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'staff'::text AS category_key,
    'Payroll & Staff'::text AS category_label,
    'payroll_disbursement'::text AS product_key,
    'Payroll Disbursements Pending'::text AS product_label,
    'hr_pay_disbursements'::text AS source_table,
    d.id AS item_id,
    d.user_id AS counterparty_id,
    COALESCE(p.full_name, 'Staff member'::text) AS counterparty_name,
    GREATEST(COALESCE(d.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (d.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    d.status,
    d.created_at
   FROM hr_pay_disbursements d
     LEFT JOIN profiles p ON p.id = d.user_id
  WHERE (COALESCE(d.status, ''::text) <> ALL (ARRAY['posted'::text, 'cancelled'::text, 'reversed'::text])) AND COALESCE(d.amount, 0::numeric) > 0::numeric
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

-- 3. Paid history: landlord payouts verified by the Receipt Archive, dated by the payout record.
CREATE OR REPLACE VIEW public.v_payables_payment_history AS
SELECT 'user'::text AS category_key,
    'withdrawal_request'::text AS product_key,
    (COALESCE(w.processed_at, w.updated_at) AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(w.amount, 0::numeric) AS amount
   FROM withdrawal_requests w
  WHERE (w.status = ANY (ARRAY['completed'::text, 'paid'::text])) AND COALESCE(w.processed_at, w.updated_at) IS NOT NULL
UNION ALL
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
 SELECT 'staff'::text AS category_key,
    'payroll_disbursement'::text AS product_key,
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'salary_payout'::text
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

-- 4. The CFO weekly view (and, with p_week_start, that week's payouts).
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
  -- Every payout is in exactly ONE top-level group, so groups can be added: confirmed + payable + historical_review +
  -- review_only + not_paid = all payouts. payable = payable_under_review + payable_awaiting_receipt (its two parts,
  -- never added to payable again). confirmed_flagged is a part of confirmed.
  WITH s0 AS MATERIALIZED (
    SELECT s.*,
           CASE WHEN s.state = 'confirmed' THEN 'confirmed'
                WHEN s.state = 'paid_unconfirmed' THEN 'payable'
                WHEN s.state = 'historical_review' THEN 'historical_review'
                WHEN s.under_review THEN 'review_only'
                ELSE 'not_paid' END AS grp
      FROM public.v_landlord_payout_settlement s),
  al AS (
    SELECT a.week_start, sum(a.amount) AS allocated, count(*) AS allocated_count,
           COALESCE(sum(a.amount) FILTER (WHERE NOT EXISTS (SELECT 1 FROM s0 s WHERE s.rent_request_id = a.rent_request_id AND s.paid_out)), 0) AS approved_not_paid,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM s0 s WHERE s.rent_request_id = a.rent_request_id AND s.paid_out)) AS approved_not_paid_count
      FROM public.landlord_float_budget_allocations a
     WHERE a.released_at IS NULL
     GROUP BY a.week_start),
  fl AS (
    SELECT DISTINCT ON (b.period_start) b.period_start, b.amount
      FROM public.landlord_float_budgets b
     WHERE b.period_type = 'weekly' AND b.superseded_at IS NULL
     ORDER BY b.period_start, b.created_at DESC),
  pw AS (
    SELECT s.report_week_start AS week_start, s.has_weekly_float,
           COALESCE(sum(s.amount) FILTER (WHERE s.paid_out), 0) AS paid_out, count(*) FILTER (WHERE s.paid_out) AS paid_out_count,
           COALESCE(sum(s.amount) FILTER (WHERE s.grp = 'confirmed'), 0) AS confirmed, count(*) FILTER (WHERE s.grp = 'confirmed') AS confirmed_count,
           COALESCE(sum(s.amount) FILTER (WHERE s.grp = 'payable'), 0) AS payable, count(*) FILTER (WHERE s.grp = 'payable') AS payable_count,
           COALESCE(sum(s.amount) FILTER (WHERE s.payable_class = 'under_review'), 0) AS payable_under_review,
           count(*) FILTER (WHERE s.payable_class = 'under_review') AS payable_under_review_count,
           COALESCE(sum(s.amount) FILTER (WHERE s.payable_class = 'awaiting_receipt'), 0) AS payable_awaiting_receipt,
           count(*) FILTER (WHERE s.payable_class = 'awaiting_receipt') AS payable_awaiting_receipt_count,
           COALESCE(sum(s.amount) FILTER (WHERE s.grp = 'historical_review'), 0) AS historical_review,
           count(*) FILTER (WHERE s.grp = 'historical_review') AS historical_review_count,
           COALESCE(sum(s.amount) FILTER (WHERE s.grp = 'review_only'), 0) AS review_only,
           count(*) FILTER (WHERE s.grp = 'review_only') AS review_only_count,
           count(*) FILTER (WHERE s.state = 'paid_unconfirmed' AND s.receipt_state = 'receipt_unchecked') AS receipt_unchecked_count
      FROM s0 s
     GROUP BY 1, 2
    HAVING count(*) FILTER (WHERE s.paid_out) > 0 OR count(*) FILTER (WHERE s.grp = 'review_only') > 0),
  wk AS (
    SELECT week_start, true AS has_weekly_float FROM al
    UNION SELECT period_start, true FROM fl
    UNION SELECT week_start, has_weekly_float FROM pw),
  rows AS (
    SELECT w.week_start, w.has_weekly_float,
           CASE WHEN w.has_weekly_float THEN f.amount END AS float_set,
           CASE WHEN w.has_weekly_float THEN COALESCE(a.allocated, 0) END AS approved,
           CASE WHEN w.has_weekly_float THEN COALESCE(a.approved_not_paid, 0) END AS approved_not_paid,
           CASE WHEN w.has_weekly_float THEN COALESCE(a.approved_not_paid_count, 0) END AS approved_not_paid_count,
           COALESCE(p.paid_out, 0) AS paid_out, COALESCE(p.paid_out_count, 0) AS paid_out_count,
           COALESCE(p.confirmed, 0) AS confirmed, COALESCE(p.confirmed_count, 0) AS confirmed_count,
           COALESCE(p.payable, 0) AS payable, COALESCE(p.payable_count, 0) AS payable_count,
           COALESCE(p.payable_under_review, 0) AS payable_under_review, COALESCE(p.payable_under_review_count, 0) AS payable_under_review_count,
           COALESCE(p.payable_awaiting_receipt, 0) AS payable_awaiting_receipt, COALESCE(p.payable_awaiting_receipt_count, 0) AS payable_awaiting_receipt_count,
           COALESCE(p.historical_review, 0) AS historical_review, COALESCE(p.historical_review_count, 0) AS historical_review_count,
           COALESCE(p.review_only, 0) AS review_only, COALESCE(p.review_only_count, 0) AS review_only_count,
           COALESCE(p.receipt_unchecked_count, 0) AS receipt_unchecked_count
      FROM wk w
      LEFT JOIN al a ON w.has_weekly_float AND a.week_start = w.week_start
      LEFT JOIN fl f ON w.has_weekly_float AND f.period_start = w.week_start
      LEFT JOIN pw p ON p.week_start = w.week_start AND p.has_weekly_float = w.has_weekly_float)
  SELECT jsonb_build_object(
    'as_at', now(),
    'rule', 'Evidence: the Receipt Archive only (a reversed Welile landlord receipt is flagged for review, never used as evidence). A landlord payout is confirmed only when its completed withdrawal has an archived, accessible receipt whose latest machine check of that exact file is a match, the transaction ID read from the receipt equals the withdrawal reference (11 or 12 digits), the amount read equals the withdrawal and payout amounts, the ID and reference are used by no other payout, and no open integrity alert makes the receipt unreliable. SMS and provider statements never confirm a payout. Paid-out payouts not confirmed are payable, except those paid before the archive start date, which are historical review items for the CFO. Groups do not overlap; payable_under_review and payable_awaiting_receipt are the two parts of payable.',
    'archive_from', (SELECT max(archive_from) FROM s0),
    'totals', (SELECT jsonb_build_object(
        'payouts', count(*), 'payouts_amount', COALESCE(sum(amount), 0),
        'paid_out', COALESCE(sum(amount) FILTER (WHERE paid_out), 0), 'paid_out_count', count(*) FILTER (WHERE paid_out),
        'confirmed', COALESCE(sum(amount) FILTER (WHERE grp = 'confirmed'), 0), 'confirmed_count', count(*) FILTER (WHERE grp = 'confirmed'),
        'confirmed_flagged', COALESCE(sum(amount) FILTER (WHERE grp = 'confirmed' AND under_review), 0),
        'confirmed_flagged_count', count(*) FILTER (WHERE grp = 'confirmed' AND under_review),
        'payable', COALESCE(sum(amount) FILTER (WHERE grp = 'payable'), 0), 'payable_count', count(*) FILTER (WHERE grp = 'payable'),
        'payable_under_review', COALESCE(sum(amount) FILTER (WHERE payable_class = 'under_review'), 0),
        'payable_under_review_count', count(*) FILTER (WHERE payable_class = 'under_review'),
        'payable_awaiting_receipt', COALESCE(sum(amount) FILTER (WHERE payable_class = 'awaiting_receipt'), 0),
        'payable_awaiting_receipt_count', count(*) FILTER (WHERE payable_class = 'awaiting_receipt'),
        'payable_with_weekly_float', COALESCE(sum(amount) FILTER (WHERE grp = 'payable' AND has_weekly_float), 0),
        'payable_without_weekly_float', COALESCE(sum(amount) FILTER (WHERE grp = 'payable' AND NOT has_weekly_float), 0),
        'historical_review', COALESCE(sum(amount) FILTER (WHERE grp = 'historical_review'), 0),
        'historical_review_count', count(*) FILTER (WHERE grp = 'historical_review'),
        'review_only', COALESCE(sum(amount) FILTER (WHERE grp = 'review_only'), 0), 'review_only_count', count(*) FILTER (WHERE grp = 'review_only'),
        'not_paid', COALESCE(sum(amount) FILTER (WHERE grp = 'not_paid'), 0), 'not_paid_count', count(*) FILTER (WHERE grp = 'not_paid'),
        'approved_not_paid', (SELECT COALESCE(sum(approved_not_paid), 0) FROM al),
        'exception_count', count(*) FILTER (WHERE under_review))
      FROM s0),
    'receipt_states', (SELECT COALESCE(jsonb_object_agg(k, x), '{}'::jsonb) FROM (
        SELECT grp || ':' || COALESCE(receipt_state, 'not_paid_out') AS k,
               jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount), 0)) AS x
          FROM s0 GROUP BY 1) q),
    'by_week', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.week_start DESC, r.has_weekly_float DESC), '[]'::jsonb) FROM rows r),
    'exceptions', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'payout_id', s.payout_id, 'landlord', s.landlord_name, 'amount', s.amount, 'paid_date', s.paid_date,
          'paid_date_source', s.paid_date_source, 'payout_status', s.payout_status, 'state', s.state, 'group', s.grp,
          'is_payable', s.grp = 'payable', 'exception', s.exception, 'exceptions', to_jsonb(s.exceptions),
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

-- 5. Grants. The view stays service_role only; the RPC checks roles itself (payables_guard).
REVOKE ALL ON public.v_landlord_payout_settlement FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_landlord_payout_settlement TO service_role;
REVOKE ALL ON public.v_payables_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_payables_lines TO service_role;
REVOKE ALL ON public.v_payables_payment_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_payables_payment_history TO service_role;
REVOKE ALL ON FUNCTION public.get_landlord_payables_by_week(date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_landlord_payables_by_week(date, boolean) TO authenticated, service_role;

RESET lock_timeout;
