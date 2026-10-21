-- Rollback for 20261020210000_budget_payables.sql
-- Restores v_payables_lines, v_payables_payment_history and payables_category_frame to their exact
-- 2026-10-20 bodies and removes the budget view, the CFO function and the config key. Reporting only.
-- Roll this back BEFORE 20261020200000 (its rollback drops budget_line_id, which these views read).

-- B4: give up after 5 s instead of queueing behind dashboard queries, and refuse to run if the views
-- were changed again after this migration — restoring the 2026-10-20 bodies would then erase that
-- later change. In that case, reverse the budget branch by hand from the current definitions.
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regclass('public.v_landlord_payout_settlement') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: roll back 20261021190000_landlord_payables_weekly_float before this migration';
  END IF;
  IF position('v_budget_payables_lines' IN pg_get_viewdef('public.v_payables_lines'::regclass)) = 0
     OR position('v_budget_payables_lines' IN pg_get_viewdef('public.v_payables_payment_history'::regclass)) = 0
     OR position('''budget''' IN pg_get_functiondef('public.payables_category_frame()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'precondition failed: the payables views are no longer the ones 20261020210000 created; reverse it by hand';
  END IF;
END
$pre$;

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
  WHERE (COALESCE(d.status, ''::text) <> ALL (ARRAY['posted'::text, 'cancelled'::text, 'reversed'::text])) AND COALESCE(d.amount, 0::numeric) > 0::numeric;

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
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'salary_payout'::text;

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
    ('other','Unclassified / Other',6)
  ) f(category_key, category_label, sort_order)
$function$;

DROP FUNCTION IF EXISTS public.get_budget_payables();
DROP VIEW IF EXISTS public.v_budget_payables_lines;
DELETE FROM public.system_config WHERE key = 'budget_payables_from';

REVOKE ALL ON public.v_payables_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_payables_lines TO service_role;
REVOKE ALL ON public.v_payables_payment_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_payables_payment_history TO service_role;

RESET lock_timeout;
