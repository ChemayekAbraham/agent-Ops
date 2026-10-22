-- 2026-10-20: departmental weekly budgets on the payables report (payables part 2).
--
-- Decided by the CFO (2026-10-20):
--   * A departmental budget line is a PAYABLE once its budget is on the CFO dashboard (past the COO
--     step, exactly as budget_review_queue admits it) — whether the CFO has approved it or not — at the
--     SUBMITTED amount. Rejected / cancelled / superseded budgets and lines rejected by the CFO or COO
--     are excluded. Only WEEKLY calls ('5days') whose period ends on or after 20 Oct 2026 count
--     (system_config.budget_payables_from).
--   * AFTER THE PERIOD ENDS (CFO decision 2026-10-21): no requisition can use the line any more (it must fall inside the
--     call period), so an approved line is payable only for its approved requisitions not yet credited (ledger-proven);
--     a line the CFO has not approved no longer counts; the unused remainder lapses and is reported as lapsed_amount,
--     never as a payable.
--   * Supplementary budgets (budget_supplements) raise a line's payable by the same rule: once a supplement
--     has reached the CFO (pending_cfo or approved, past the COO step) at the amount requested. Pending-COO,
--     rejected and cancelled supplements do not count. The rule lives in requisition_budget_line_supplements()
--     (migration 20261020200000), so requisition limits and payables can never disagree.
--   * The budget workflow never credits a wallet. Spending happens through requisitions, which are
--     credited to the employee's wallet (requisition_wallet_credits). A line's payable falls by what
--     its LINKED requisitions (budget_line_id, migration 20261020200000) have been credited. From that
--     moment the money is a user wallet balance, already on this report, so nothing is counted twice.
--   * Existing payables (wallets, withdrawals, Supporter Returns, landlord payouts, agents, payroll)
--     are unchanged: the live bodies of v_payables_lines and v_payables_payment_history are embedded
--     verbatim below and only a 'budget' branch is appended.
--
-- REPORTING ONLY. No ledger entry, wallet, budget status or requisition is written.
-- Requires 20261020200000_requisition_budget_line_reference (budget_line_id columns).
-- Live bodies as at 2026-10-20: v_payables_lines md5 91257d370d3227f8c5e1397205e8e45f,
-- v_payables_payment_history md5 b9c658098a3b3e800cff688c78b2f838 — re-check before applying.
-- Rollback: supabase/rollbacks/20261020210000_budget_payables.rollback.sql
-- Verification (rolled back): supabase/tests/budget_payables.sql

-- 0. Safety (B4). Replacing v_payables_lines briefly locks it; give up after 5 s rather than queue the
--    CFO dashboards behind this migration. And refuse to run unless the three objects it replaces are
--    still EXACTLY the definitions embedded below — otherwise a change made since 2026-10-20 would be
--    silently overwritten. If this fails, regenerate the migration from the current definitions.
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF md5(pg_get_viewdef('public.v_payables_lines'::regclass)) <> '91257d370d3227f8c5e1397205e8e45f' THEN
    RAISE EXCEPTION 'precondition failed: v_payables_lines changed since 2026-10-20 (md5 %); regenerate this migration', md5(pg_get_viewdef('public.v_payables_lines'::regclass));
  END IF;
  IF md5(pg_get_viewdef('public.v_payables_payment_history'::regclass)) <> 'b9c658098a3b3e800cff688c78b2f838' THEN
    RAISE EXCEPTION 'precondition failed: v_payables_payment_history changed since 2026-10-20 (md5 %); regenerate this migration', md5(pg_get_viewdef('public.v_payables_payment_history'::regclass));
  END IF;
  IF md5(pg_get_functiondef('public.payables_category_frame()'::regprocedure)) <> 'd20d4714699f75b186216b421e990cfa' THEN
    RAISE EXCEPTION 'precondition failed: payables_category_frame changed since 2026-10-20; regenerate this migration';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'budget_line_id'
         AND table_name IN ('staff_requisitions', 'employee_requisitions', 'director_requisitions')) <> 3 THEN
    RAISE EXCEPTION 'precondition failed: apply 20261020200000_requisition_budget_line_reference first';
  END IF;
  IF to_regprocedure('public.requisition_budget_line_supplements(uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: requisition_budget_line_supplements is missing; re-apply 20261020200000_requisition_budget_line_reference';
  END IF;
END
$pre$;

INSERT INTO public.system_config (key, value, updated_at)
VALUES ('budget_payables_from', to_jsonb('2026-10-20'::text), now())
ON CONFLICT (key) DO NOTHING;

-- 1. Every in-scope budget line with submitted, supplement, credited, in-progress and outstanding amounts.

CREATE OR REPLACE VIEW public.v_budget_payables_lines AS
WITH cfg AS (
  SELECT COALESCE((SELECT (c.value #>> '{}')::date FROM public.system_config c WHERE c.key = 'budget_payables_from'),
                  DATE '2026-10-20') AS from_date
),
linked AS (                      -- every requisition that references a budget line
  SELECT s.budget_line_id, 'staff_requisitions'::text AS src, s.id,
         COALESCE(s.approved_amount, s.amount) AS amount, COALESCE(s.stage, '') NOT IN ('rejected', 'cancelled') AS live,
         COALESCE(s.stage, '') = 'approved' AS approved
    FROM public.staff_requisitions s WHERE s.budget_line_id IS NOT NULL
  UNION ALL
  SELECT e.budget_line_id, 'employee_requisitions', e.id,
         COALESCE(e.approved_amount, e.amount), COALESCE(e.status, '') NOT IN ('rejected', 'cancelled'),
         COALESCE(e.status, '') IN ('approved', 'paid')            -- 'paid' alone is not proof: open until a ledger-proven credit
    FROM public.employee_requisitions e WHERE e.budget_line_id IS NOT NULL
  UNION ALL
  SELECT d.budget_line_id, 'director_requisitions', d.id,
         d.amount, COALESCE(d.status, '') NOT IN ('rejected', 'cancelled'),
         COALESCE(d.status, '') = 'approved'
    FROM public.director_requisitions d WHERE d.budget_line_id IS NOT NULL
),
-- B1: a credit only counts when the wallet ledger proves it: requisition_wallet_credits.wallet_transaction_id
-- is the reference cfo-direct-credit posted, and general_ledger must hold the wallet cash_in for that
-- reference, to that user, for that amount. A 'credited' status alone is not proof.
credits AS (
  SELECT w.source_table, w.requisition_id, w.amount,
         (NULLIF(w.wallet_transaction_id, '') IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.general_ledger g
                       WHERE g.reference_id = w.wallet_transaction_id
                         AND g.ledger_scope = 'wallet' AND g.direction = 'cash_in'
                         AND g.user_id = w.user_id AND abs(g.amount - w.amount) < 1)) AS ledger_proven
    FROM public.requisition_wallet_credits w
   WHERE w.status = 'credited'
),
per_line AS (
  SELECT k.budget_line_id,
         COALESCE(SUM(c.amount) FILTER (WHERE c.ledger_proven), 0)                                   AS credited_amount,
         COUNT(*) FILTER (WHERE c.ledger_proven)                                                     AS credited_count,
         COALESCE(SUM(c.amount) FILTER (WHERE c.requisition_id IS NOT NULL AND NOT c.ledger_proven), 0) AS unproven_credit_amount,
         COUNT(*) FILTER (WHERE c.requisition_id IS NOT NULL AND NOT c.ledger_proven)                AS unproven_credit_count,
         COALESCE(SUM(k.amount) FILTER (WHERE k.live AND c.requisition_id IS NULL), 0)                AS in_progress_amount,
         COUNT(*) FILTER (WHERE k.live AND c.requisition_id IS NULL)                                  AS in_progress_count,
         -- approved requisitions without a ledger-proven credit: the line's actual open obligation
         COALESCE(SUM(k.amount) FILTER (WHERE k.approved AND NOT COALESCE(c.ledger_proven, false)), 0)   AS approved_open_amount,
         COUNT(*) FILTER (WHERE k.approved AND NOT COALESCE(c.ledger_proven, false))                   AS approved_open_count
    FROM linked k
    LEFT JOIN credits c ON c.source_table = k.src AND c.requisition_id = k.id
   GROUP BY k.budget_line_id
)
SELECT l.id                                    AS line_id,
       s.id                                    AS submission_id,
       s.reference                             AS submission_reference,
       s.status                                AS submission_status,
       c.id                                    AS call_id,
       c.title                                 AS call_title,
       c.period_start,
       c.period_end,
       s.department_id,
       d.name                                  AS department_name,
       l.description,
       l.category,
       l.account_code,
       l.created_at                            AS line_created_at,
       l.line_total                            AS submitted_amount,
       sup.amount                              AS supplement_amount,
       COALESCE(l.line_total, 0) + sup.amount  AS allowance_amount,
       COALESCE(p.credited_amount, 0)          AS credited_amount,
       COALESCE(p.credited_count, 0)           AS credited_requisitions,
       COALESCE(p.unproven_credit_amount, 0)   AS unproven_credit_amount,
       COALESCE(p.unproven_credit_count, 0)    AS unproven_credit_requisitions,
       COALESCE(p.in_progress_amount, 0)       AS in_progress_amount,
       COALESCE(p.in_progress_count, 0)        AS in_progress_requisitions,
       -- Unproven credits do NOT reduce the payable (conservative); they are flagged instead.
       -- The allowance is the submitted amount plus supplements that reached the CFO (requisition_budget_line_supplements).
       -- While the period is open: allowance less ledger-proven credits (approved or not). After the period ends
       -- (CFO decision 2026-10-21) no requisition can use the line any more, so: an approved line is payable only for its
       -- approved requisitions not yet credited; an unapproved line no longer counts; the rest lapses (lapsed_amount).
       CASE WHEN c.period_end >= (now() AT TIME ZONE 'Africa/Kampala')::date
            THEN GREATEST(COALESCE(l.line_total, 0) + sup.amount - COALESCE(p.credited_amount, 0), 0)
            WHEN COALESCE(l.status, '') = 'approved' THEN COALESCE(p.approved_open_amount, 0)
            ELSE 0 END                                                                       AS outstanding_amount,
       (COALESCE(p.credited_amount, 0) > COALESCE(l.line_total, 0) + sup.amount)            AS overspent,
       GREATEST(COALESCE(p.credited_amount, 0) - COALESCE(l.line_total, 0) - sup.amount, 0) AS overspent_amount,
       c.period_end < (now() AT TIME ZONE 'Africa/Kampala')::date                           AS period_ended,
       COALESCE(l.status, '') = 'approved'                                                  AS line_approved,
       COALESCE(p.approved_open_amount, 0)                                                  AS approved_open_amount,
       COALESCE(p.approved_open_count, 0)                                                   AS approved_open_requisitions,
       -- unused budget after the period ends: never payable, reported so it does not silently disappear
       CASE WHEN c.period_end >= (now() AT TIME ZONE 'Africa/Kampala')::date THEN 0
            ELSE GREATEST(COALESCE(l.line_total, 0) + sup.amount - COALESCE(p.credited_amount, 0)
                          - CASE WHEN COALESCE(l.status, '') = 'approved' THEN COALESCE(p.approved_open_amount, 0) ELSE 0 END, 0)
       END                                                                                  AS lapsed_amount
  FROM public.budget_submission_lines l
  JOIN public.budget_submissions s ON s.id = l.submission_id
  JOIN public.budget_calls c       ON c.id = s.call_id
  LEFT JOIN public.hr_departments d ON d.id = s.department_id
  CROSS JOIN cfg
  LEFT JOIN per_line p ON p.budget_line_id = l.id
  CROSS JOIN LATERAL (SELECT COALESCE(public.requisition_budget_line_supplements(l.id), 0) AS amount) sup
 WHERE c.period_type = '5days'
   AND c.period_end >= cfg.from_date
   AND COALESCE(l.status, '') <> 'rejected'
   AND COALESCE(l.coo_status, '') <> 'rejected'
   AND COALESCE(s.status, '') NOT IN ('draft', 'pending_coo', 'coo_under_review', 'rejected', 'cancelled', 'superseded')
   AND (public.budget_department_route(s.department_id) <> 'coo'
        OR (s.coo_reviewed_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM public.budget_submission_events e
                         WHERE e.submission_id = s.id AND e.event_type = 'coo_forwarded')));

-- 2. The payables list: today's body unchanged + outstanding budget lines.
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
    'Landlord Payouts Outstanding'::text AS product_label,
    'landlord_payouts'::text AS source_table,
    lp.id AS item_id,
    lp.landlord_id AS counterparty_id,
    COALESCE(NULLIF(lp.landlord_name, ''::text), p.full_name, 'Unknown landlord'::text) AS counterparty_name,
    GREATEST(COALESCE(lp.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (lp.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    lp.status,
    lp.created_at
   FROM landlord_payouts lp
     LEFT JOIN profiles p ON p.id = lp.landlord_id
  WHERE (lp.status = ANY (ARRAY['awaiting_agent_receipt'::text, 'pending_merchant_payout'::text, 'failed'::text, 'pending'::text])) AND COALESCE(lp.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Rent Payouts'::text AS category_label,
    'agent_landlord_payout'::text AS product_key,
    'Agent Landlord Payouts Pending'::text AS product_label,
    'agent_landlord_payouts'::text AS source_table,
    ap.id AS item_id,
    ap.landlord_id AS counterparty_id,
    COALESCE(NULLIF(ap.landlord_name, ''::text), p.full_name, 'Unknown landlord'::text) AS counterparty_name,
    GREATEST(COALESCE(ap.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (ap.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    ap.status,
    ap.created_at
   FROM agent_landlord_payouts ap
     LEFT JOIN profiles p ON p.id = ap.landlord_id
  WHERE (ap.status = ANY (ARRAY['pending'::text, 'landlord_ops_approved'::text, 'cfo_pending'::text])) AND COALESCE(ap.amount, 0::numeric) > 0::numeric
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

-- 3. Paid history: today's body unchanged + budget requisitions credited to wallets.
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
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'rent_disbursement'::text
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'agent_landlord_payout'::text AS product_key,
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'agent_landlord_payout'::text
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

-- 4. The category list the reporting functions group by.
CREATE OR REPLACE FUNCTION public.payables_category_frame()
 RETURNS TABLE(category_key text, category_label text, sort_order integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT * FROM (VALUES
    ('user','User Wallets & Withdrawals',1),
    ('partner','Supporter Returns & Capital',2),
    ('landlord','Landlord Rent Payouts',3),
    ('agent','Agent Payables',4),
    ('staff','Payroll & Staff',5),
    ('budget','Departmental Budgets',6),
    ('other','Unclassified / Other',7)
  ) f(category_key, category_label, sort_order)
$function$;

-- 5. CFO detail: per week and department, plus requisitions credited WITHOUT a budget line (they
--    cannot reduce any budget payable — visible so the gap is never silent while the rule is off).
CREATE OR REPLACE FUNCTION public.get_budget_payables()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_from date := COALESCE((SELECT (c.value #>> '{}')::date FROM public.system_config c WHERE c.key = 'budget_payables_from'), DATE '2026-10-20');
  v jsonb;
BEGIN
  PERFORM public.payables_guard();
  SELECT jsonb_build_object(
    'as_at', now(),
    'from', v_from,
    'basis', 'Weekly budgets on the CFO dashboard (approved or not), submitted amount plus supplements that reached the CFO, less linked requisitions credited to wallets (ledger-proven)',
    'totals', (SELECT jsonb_build_object(
        'lines', COUNT(*), 'submitted', ROUND(COALESCE(SUM(submitted_amount),0),2),
        'supplements', ROUND(COALESCE(SUM(supplement_amount),0),2),
        'allowance', ROUND(COALESCE(SUM(allowance_amount),0),2),
        'credited', ROUND(COALESCE(SUM(credited_amount),0),2),
        'in_progress', ROUND(COALESCE(SUM(in_progress_amount),0),2),
        'outstanding', ROUND(COALESCE(SUM(outstanding_amount),0),2),
        'unproven_credited', ROUND(COALESCE(SUM(unproven_credit_amount),0),2),
        'unproven_lines', COUNT(*) FILTER (WHERE unproven_credit_amount > 0),
        'overspent_lines', COUNT(*) FILTER (WHERE overspent),
        'overspent_amount', ROUND(COALESCE(SUM(overspent_amount),0),2))
       FROM public.v_budget_payables_lines),
    'by_week_department', (SELECT COALESCE(jsonb_agg(x ORDER BY x.period_start DESC, x.department_name), '[]'::jsonb) FROM (
        SELECT call_id, call_title, period_start, period_end, department_id, department_name,
               COUNT(*) AS lines, ROUND(SUM(submitted_amount),2) AS submitted, ROUND(SUM(supplement_amount),2) AS supplements,
               ROUND(SUM(allowance_amount),2) AS allowance, ROUND(SUM(credited_amount),2) AS credited,
               ROUND(SUM(in_progress_amount),2) AS in_progress, ROUND(SUM(outstanding_amount),2) AS outstanding,
               ROUND(SUM(unproven_credit_amount),2) AS unproven_credited,
               bool_or(overspent) AS overspent, ROUND(SUM(overspent_amount),2) AS overspent_amount
          FROM public.v_budget_payables_lines
         GROUP BY call_id, call_title, period_start, period_end, department_id, department_name) x),
    'lines', (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.period_start DESC, b.department_name, b.outstanding_amount DESC), '[]'::jsonb)
                FROM public.v_budget_payables_lines b),
    'unlinked_credited_requisitions', (SELECT jsonb_build_object(
        'items', COALESCE(SUM(w.n), 0), 'amount', ROUND(COALESCE(SUM(w.amt),0),2),
        'by_source', COALESCE(jsonb_object_agg(w.src, w.amt) FILTER (WHERE w.src IS NOT NULL), '{}'::jsonb))
       FROM (SELECT w.source_table AS src, SUM(w.amount) AS amt, COUNT(*) AS n
               FROM public.requisition_wallet_credits w
              WHERE w.status = 'credited' AND w.credited_at >= v_from
                AND NOT EXISTS (SELECT 1 FROM public.staff_requisitions s    WHERE w.source_table = 'staff_requisitions'    AND s.id = w.requisition_id AND s.budget_line_id IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM public.employee_requisitions e WHERE w.source_table = 'employee_requisitions' AND e.id = w.requisition_id AND e.budget_line_id IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM public.director_requisitions d WHERE w.source_table = 'director_requisitions' AND d.id = w.requisition_id AND d.budget_line_id IS NOT NULL)
              GROUP BY w.source_table) w)
  ) INTO v;
  RETURN v;
END;
$function$;

-- 6. Grants: owner-rights views stay service_role only (as v_payables_lines since 20261018190000).
REVOKE ALL ON public.v_budget_payables_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_budget_payables_lines TO service_role;
REVOKE ALL ON public.v_payables_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_payables_lines TO service_role;
REVOKE ALL ON public.v_payables_payment_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_payables_payment_history TO service_role;
REVOKE ALL ON FUNCTION public.get_budget_payables() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_budget_payables() TO authenticated, service_role;

RESET lock_timeout;
