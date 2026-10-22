-- 2026-10-22: CFO Dashboard -> Payables categories, revised (CFO request 2026-10-22). CLASSIFICATION AND LABELS ONLY.
--
--   Renamed (same records, same keys, same amounts):
--     partner   Supporter Returns & Capital   -> Partner Products and Services
--     landlord  Landlord Float Payout Budget  -> Land Products and Services
--     budget    Departmental Budgets          -> Operational Expenses
--     agent     Agent Commissions             -> Agent Products and Services (CFO correction 2026-10-22: one unified agent
--               category; the list rows said "Agent Payables"). Agent commission payables keep their records, amounts and
--               product line (agent_commission_payout, "Agent Commission Payouts") inside it.
--   Added:
--     marketing       Marketing Expenses: departmental budget lines of the Marketing department
--     rnd             R&D (Research and Development): departmental budget lines of Product Research and Development
--   Every other departmental budget line stays Operational Expenses. The department -> category list is in one place
--   (dm, in the departmental branch of v_payables_lines).
--
--   Proxy Agent Promissory Note Commissions (CFO request 2026-10-22), inside Partner Products and Services:
--     Payables list: only GENUINELY UNPAID commissions become Partner lines -- the system recorded them as due and no
--     wallet credit exists:
--       proxy_note_registration_bonus     approval recorded a bonus (> 0) but no wallet credit 'promissory_note_verified:<note>'
--       proxy_note_fulfilment_commission  unattributed fund-in whose earner is a promissory-note Proxy Agent (first fund-in)
--       proxy_note_topup_commission       same, later fund-ins (top-ups)
--       proxy_lead_override               lead override whose posting failed and has no wallet credit (shown separately)
--     Commissions already credited to a wallet are wallet balances, never payables, so nothing paid is counted again.
--     Fund-in lines are read only for partners who already have a paid fund-in (the engine's locked earner), which keeps the
--     list fast. A fund-in the commission gate has not attributed to a Proxy Agent is NOT treated as owing nothing: its
--     eligibility and amount are unconfirmed, so it stays out of the payables totals and the report lists it as an
--     investigation item (with the commission it would carry if eligible) until it is attributed and confirmed.
--     Today none of these lines exist (verified read-only on production), so every payables total is unchanged.
--   Added: get_partner_promissory_commissions(p_from, p_to): the section's report. Paid = wallet credits net of reversals
--   (optionally by credit date); unpaid = the Partner lines above (so it ties to the payables total); investigation items
--   (historical overpayments, deleted-note bonuses, Sales Officer eligibility cases, deposits awaiting confirmation,
--   fund-ins awaiting introducer attribution) are information only and in no total. The UGX 11,600 historical
--   recalculation top-ups (paid 2026-10-02) are a separate paid-only line, outside the commission totals.
--   Read-only; payables roles only (payables_guard).
--
-- Each record keeps one line, one amount and one category: totals are unchanged and every category total adds up to the
-- payables total (verified read-only against production before this file was written). Category keys of existing
-- records are kept, so payment history and the forecasts keep their identity; only their labels change.
--
-- REPORTING ONLY. No ledger entry, wallet, payout, budget, requisition, commission rule or existing grant is written or
-- changed; the new report function reads only. CREATE OR REPLACE keeps every grant. Independent of 20261022130000_payables_single_read_speedup (different objects); either order works.
-- TRANSACTION: run the file as ONE transaction (the migration tool does; by hand, wrap it in BEGIN; ... COMMIT;). The
-- guard changes nothing when it refuses. Function checks ignore carriage returns (CRLF checkouts).
-- Rollback: supabase/rollbacks/20261022180000_payables_categories_v2.rollback.sql

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF md5(pg_get_viewdef('public.v_payables_lines'::regclass)) IS DISTINCT FROM '756c153a1434a56ed1f45b4ba8c39d62'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.payables_category_frame()'::regprocedure) IS DISTINCT FROM '20aaa62fea88849a1f7c993810dea188'
     OR to_regclass('public.hr_departments') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'v_budget_payables_lines' AND column_name = 'department_id')
     OR to_regprocedure('public.get_partner_promissory_commissions(date,date)') IS NOT NULL
     OR to_regprocedure('public.commission_resolve_earner(uuid,timestamp with time zone,boolean)') IS NULL
     OR to_regprocedure('public.commission_partner_has_prior_fund_in(uuid,text,timestamp with time zone)') IS NULL
     OR to_regprocedure('public.promissory_commission_rate(text,timestamp with time zone)') IS NULL
     OR to_regprocedure('public.partner_note_rate(text,timestamp with time zone)') IS NULL
     OR to_regclass('public.commission_fund_ins') IS NULL OR to_regclass('public.commission_fund_in_candidates') IS NULL
     OR to_regclass('public.commission_recompute_lines') IS NULL OR to_regclass('public.commission_gate_settings') IS NULL
     OR to_regclass('public.partner_note_overrides') IS NULL OR to_regclass('public.promissory_commission_events') IS NULL
     OR to_regclass('public.pending_wallet_operations') IS NULL OR to_regclass('public.v_pso_officers') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'action') THEN
    RAISE EXCEPTION 'precondition failed: v_payables_lines or payables_category_frame changed since 2026-10-22; nothing was changed. Regenerate this migration from the current definitions';
  END IF;
END
$pre$;

-- 1. The category list the payables reports group by.
CREATE OR REPLACE FUNCTION public.payables_category_frame()
 RETURNS TABLE(category_key text, category_label text, sort_order integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT * FROM (VALUES
    ('partner','Partner Products and Services',1),
    ('landlord','Land Products and Services',2),
    ('agent','Agent Products and Services',3),
    ('budget','Operational Expenses',4),
    ('marketing','Marketing Expenses',5),
    ('rnd','R&D (Research and Development)',6),
    ('other','Unclassified / Other',7)
  ) f(category_key, category_label, sort_order)
$function$;

-- 2. The payables list: new labels; departmental budget lines classified by department; genuinely unpaid Proxy Agent
--    promissory note commissions as Partner lines.
CREATE OR REPLACE VIEW public.v_payables_lines AS
SELECT 'partner'::text AS category_key,
    'Partner Products and Services'::text AS category_label,
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
    'Land Products and Services'::text AS category_label,
        CASE
            WHEN f.overspent THEN 'landlord_float_overspent'::text
            ELSE 'landlord_float_budget'::text
        END AS product_key,
        CASE
            WHEN f.overspent THEN 'Landlord float — overspent (verified payouts above the float)'::text
            ELSE 'Weekly Landlord Float Budget'::text
        END AS product_label,
    'landlord_float_budgets'::text AS source_table,
    f.float_id AS item_id,
    NULL::uuid AS counterparty_id,
    'Landlord float, week of '::text || to_char(f.week_start::timestamp without time zone, 'DD Mon YYYY'::text) AS counterparty_name,
    f.outstanding_amount,
    f.week_end AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
        CASE
            WHEN f.overspent THEN 'overspent'::text
            WHEN f.week_ended THEN 'week_ended'::text
            WHEN f.unverified_count > 0 THEN 'receipts_pending'::text
            ELSE 'open'::text
        END AS status,
    f.created_at
   FROM v_landlord_float_payables f
  WHERE f.outstanding_amount > 0::numeric OR f.overspent
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Land Products and Services'::text AS category_label,
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
        CASE
            WHEN s.no_float_basis = 'attempt_ended_unpaid'::text AND s.payout_status = 'failed'::text THEN 'payout_failed_unpaid'::text
            WHEN s.no_float_basis = 'attempt_ended_unpaid'::text THEN 'completed_without_payment'::text
            ELSE s.payout_status
        END AS status,
    s.created_at
   FROM v_landlord_payout_settlement s
  WHERE s.approved_no_float AND s.amount > 0::numeric
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products and Services'::text AS category_label,
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
 SELECT COALESCE(dm.category_key, 'budget'::text) AS category_key,
    COALESCE(dm.category_label, 'Operational Expenses'::text) AS category_label,
        CASE
            WHEN b.overspent THEN COALESCE(dm.product_key, 'department_budget'::text) || '_overspent'::text
            ELSE COALESCE(dm.product_key, 'department_budget'::text)
        END AS product_key,
        CASE
            WHEN b.overspent THEN COALESCE(dm.overspent_label, 'Departmental Budgets'::text) || ' — overspent (credited above budget)'::text
            ELSE COALESCE(dm.product_label, 'Departmental Weekly Budgets'::text)
        END AS product_label,
    'budget_submission_lines'::text AS source_table,
    b.line_id AS item_id,
    b.department_id AS counterparty_id,
    COALESCE(b.department_name, 'Unknown department'::text) AS counterparty_name,
    b.outstanding_amount,
    b.period_end AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
        CASE
            WHEN b.overspent THEN 'overspent'::text
            WHEN b.unproven_credit_amount > 0::numeric THEN 'credit_unproven'::text
            ELSE b.submission_status
        END AS status,
    b.line_created_at AS created_at
   FROM v_budget_payables_lines b
     LEFT JOIN hr_departments hd ON hd.id = b.department_id
     LEFT JOIN ( VALUES ('marketing'::text, 'marketing'::text, 'Marketing Expenses'::text, 'marketing_budget'::text, 'Marketing Weekly Budgets'::text, 'Marketing Budgets'::text),
                ('product_research_and_development'::text, 'rnd'::text, 'R&D (Research and Development)'::text, 'rnd_budget'::text, 'R&D Weekly Budgets'::text, 'R&D Budgets'::text)) dm(department_key, category_key, category_label, product_key, product_label, overspent_label) ON dm.department_key = hd.key
  WHERE b.outstanding_amount > 0::numeric OR b.overspent
UNION ALL
 SELECT 'partner'::text AS category_key,
    'Partner Products and Services'::text AS category_label,
    'proxy_note_registration_bonus'::text AS product_key,
    'Proxy Agent promissory note registration bonus — unpaid'::text AS product_label,
    'promissory_notes'::text AS source_table,
    n.id AS item_id,
    n.agent_id AS counterparty_id,
    COALESCE(pa.full_name, 'Unknown proxy agent'::text) AS counterparty_name,
    a.bonus AS outstanding_amount,
    (n.approved_at AT TIME ZONE 'Africa/Kampala'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    'verified_bonus_not_credited'::text AS status,
    n.created_at
   FROM promissory_notes n
     LEFT JOIN ( SELECT DISTINCT gl.source_id
           FROM general_ledger gl
          WHERE gl.source_table = 'promissory_notes'::text AND gl.idempotency_key = ('promissory_note_verified:'::text || gl.source_id::text) AND gl.ledger_scope = 'wallet'::text AND gl.direction = 'cash_in'::text) bp ON bp.source_id = n.id
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN (al.metadata ->> 'bonus_amount'::text) ~ '^[0-9]+(\.[0-9]+)?$'::text THEN (al.metadata ->> 'bonus_amount'::text)::numeric
                    ELSE 0::numeric
                END AS bonus
           FROM audit_logs al
          WHERE al.table_name = 'promissory_notes'::text AND al.record_id = n.id::text AND al.action = 'approve_promissory_note'::text
          ORDER BY al.created_at DESC
         LIMIT 1) a
     LEFT JOIN profiles pa ON pa.id = n.agent_id
  WHERE n.approval_bonus_paid AND bp.source_id IS NULL AND a.bonus > 0::numeric
UNION ALL
 SELECT 'partner'::text AS category_key,
    'Partner Products and Services'::text AS category_label,
        CASE k.kind
            WHEN 'portfolio_creation'::text THEN 'proxy_note_fulfilment_commission'::text
            ELSE 'proxy_note_topup_commission'::text
        END AS product_key,
        CASE k.kind
            WHEN 'portfolio_creation'::text THEN 'Proxy Agent fulfilment commission — unpaid'::text
            ELSE 'Proxy Agent top-up commission — unpaid'::text
        END AS product_label,
    'commission_fund_ins'::text AS source_table,
    f.id AS item_id,
    r.earner_id AS counterparty_id,
    COALESCE(pe.full_name, 'Unknown proxy agent'::text) AS counterparty_name,
    round(f.amount * rt.rate) AS outstanding_amount,
    (f.occurred_at AT TIME ZONE 'Africa/Kampala'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    'awaiting_commission_gate'::text AS status,
    f.created_at
   FROM commission_fund_ins f
     CROSS JOIN LATERAL ( SELECT e.earner_id,
            e.earner_path
           FROM commission_resolve_earner(f.partner_id, f.occurred_at, true) e(earner_id, earner_path, note_id, assignment_id, basis)
         LIMIT 1) r
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN commission_partner_has_prior_fund_in(f.partner_id, f.fund_in_key, f.occurred_at) THEN 'portfolio_topup'::text
                    ELSE 'portfolio_creation'::text
                END AS kind) k
     CROSS JOIN LATERAL ( SELECT COALESCE(promissory_commission_rate(k.kind, f.occurred_at), 0::numeric) AS rate) rt
     LEFT JOIN profiles pe ON pe.id = r.earner_id
  WHERE f.status = 'unattributed'::text AND (EXISTS ( SELECT 1
           FROM commission_fund_ins pf
          WHERE pf.partner_id = f.partner_id AND pf.status = 'paid'::text)) AND r.earner_path = 'promissory_note'::text AND round(f.amount * rt.rate) > 0::numeric AND NOT (f.fund_in_key ~~ 'pwo:%'::text AND (EXISTS ( SELECT 1
           FROM pending_wallet_operations w
          WHERE w.id::text = split_part(f.fund_in_key, ':'::text, 2) AND w.created_at < (( SELECT s.cutover_at
                   FROM commission_gate_settings s
                  WHERE s.id))))) AND NOT (EXISTS ( SELECT 1
           FROM general_ledger gl
          WHERE gl.idempotency_key = ('fund_in_commission:'::text || f.fund_in_key)))
UNION ALL
 SELECT 'partner'::text AS category_key,
    'Partner Products and Services'::text AS category_label,
    'proxy_lead_override'::text AS product_key,
    'Proxy Agent lead override — unpaid'::text AS product_label,
    'partner_note_overrides'::text AS source_table,
    o.id AS item_id,
    o.lead_user_id AS counterparty_id,
    COALESCE(pl.full_name, 'Unknown lead'::text) AS counterparty_name,
    o.amount AS outstanding_amount,
    (o.approved_at AT TIME ZONE 'Africa/Kampala'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    'override_posting_failed'::text AS status,
    o.created_at
   FROM partner_note_overrides o
     LEFT JOIN profiles pl ON pl.id = o.lead_user_id
  WHERE o.status = 'failed'::text AND o.amount > 0::numeric AND o.lead_user_id IS NOT NULL AND NOT (EXISTS ( SELECT 1
           FROM general_ledger gl
          WHERE gl.idempotency_key = ('promissory_note_lead:'::text || o.note_id::text) AND gl.ledger_scope = 'wallet'::text AND gl.direction = 'cash_in'::text));

-- 3. The Proxy Agent Promissory Note Commissions report (Partner Products and Services). New function: closed by default,
--    opened to signed-in users here; payables_guard() inside limits it to the payables roles.
CREATE OR REPLACE FUNCTION public.get_partner_promissory_commissions(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM payables_guard();
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', p_from, p_to USING ERRCODE = '22023';
  END IF;
  RETURN (
    WITH credits AS (
      -- Paid = credited to the payee's wallet. Registration bonus and lead override legs are keyed per note.
      SELECT CASE WHEN g.idempotency_key = 'promissory_note_verified:' || g.source_id::text THEN 'registration_bonus' ELSE 'lead_override' END AS product,
             g.user_id, g.amount, g.source_id AS note_id
        FROM general_ledger g
       WHERE g.source_table = 'promissory_notes' AND g.ledger_scope = 'wallet' AND g.direction = 'cash_in'
         AND g.idempotency_key IN ('promissory_note_verified:' || g.source_id::text, 'promissory_note_lead:' || g.source_id::text)
         AND (p_from IS NULL OR (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date >= p_from)
         AND (p_to IS NULL OR (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date <= p_to)
      UNION ALL
      -- Reversals of those credits (reverse_promissory_note_bonus) reduce what was paid.
      SELECT CASE WHEN g.idempotency_key LIKE '%:agent' THEN 'registration_bonus' ELSE 'lead_override' END, g.user_id, -g.amount, g.source_id
        FROM general_ledger g
       WHERE g.source_table = 'promissory_notes' AND g.ledger_scope = 'wallet' AND g.direction = 'cash_out'
         AND g.idempotency_key IN ('promissory_note_reversed:' || g.source_id::text || ':agent', 'promissory_note_reversed:' || g.source_id::text || ':lead')
         AND (p_from IS NULL OR (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date >= p_from)
         AND (p_to IS NULL OR (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date <= p_to)
      UNION ALL
      -- Fulfilment / top-up commissions and the 2026-10-02 recalculation top-ups: counted only where the wallet credit exists.
      SELECT CASE pe.kind WHEN 'portfolio_creation' THEN 'fulfilment_commission' WHEN 'portfolio_topup' THEN 'topup_commission'
                          ELSE 'recalculation_topup' END, pe.agent_id, pe.amount, pe.note_id
        FROM promissory_commission_events pe
        CROSS JOIN LATERAL (SELECT g.transaction_date FROM general_ledger g
                             WHERE g.transaction_group_id = pe.ledger_group_id AND g.ledger_scope = 'wallet' AND g.direction = 'cash_in'
                               AND g.user_id = pe.agent_id AND g.amount = pe.amount
                             ORDER BY g.transaction_date LIMIT 1) g
       WHERE pe.status = 'paid' AND pe.kind IN ('portfolio_creation', 'portfolio_topup', 'recompute_adjustment')
         AND (p_from IS NULL OR (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date >= p_from)
         AND (p_to IS NULL OR (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date <= p_to)
    ),
    products(product, sort_order, label, rule, unpaid_key) AS (VALUES
      ('registration_bonus', 1, 'Registration bonus', 'UGX ' || to_char(COALESCE(partner_note_rate('agent', now()), 0), 'FM999,999,990') || ' per eligible verified promissory note', 'proxy_note_registration_bonus'),
      ('fulfilment_commission', 2, 'Fulfilment commission', rtrim(to_char(COALESCE(promissory_commission_rate('portfolio_creation', now()), 0) * 100, 'FM990.99'), '.') || '% of principal on the partner''s first fund-in', 'proxy_note_fulfilment_commission'),
      ('topup_commission', 3, 'Subsequent top-up commission', rtrim(to_char(COALESCE(promissory_commission_rate('portfolio_topup', now()), 0) * 100, 'FM990.99'), '.') || '% of each eligible top-up, to the original Proxy Agent', 'proxy_note_topup_commission'),
      ('recalculation_topup', 4, 'Historical recalculation top-ups (paid 2 Oct 2026)', 'Historical amounts already paid: shortfalls settled once by the 2026-10-02 commission recalculation. Paid only, never a payable, not part of the commission totals', NULL),
      ('lead_override', 5, 'Proxy Agent lead override (shown separately)', 'UGX ' || to_char(COALESCE(partner_note_rate('lead', now()), 0), 'FM999,999,990') || ' per verified note, to the Proxy Agent''s lead', 'proxy_lead_override')
    ),
    paid AS (SELECT product, count(*) FILTER (WHERE amount > 0) - count(*) FILTER (WHERE amount < 0) AS n, count(DISTINCT user_id) AS payees, COALESCE(sum(amount), 0) AS amount FROM credits GROUP BY product),
    unpaid_lines AS (SELECT l.* FROM v_payables_lines l
                      WHERE l.category_key = 'partner' AND l.product_key IN ('proxy_note_registration_bonus', 'proxy_note_fulfilment_commission', 'proxy_note_topup_commission', 'proxy_lead_override')),
    unpaid AS (SELECT product_key, count(*) AS n, COALESCE(sum(outstanding_amount), 0) AS amount,
                      jsonb_agg(jsonb_build_object('source', source_table, 'item_id', item_id, 'payee_id', counterparty_id, 'payee', counterparty_name,
                                                   'amount', outstanding_amount, 'due_date', due_date, 'status', status) ORDER BY due_date, item_id) AS items
                 FROM unpaid_lines GROUP BY product_key),
    lines AS (SELECT p.product, p.sort_order, p.label, p.rule, p.unpaid_key IS NULL AS historical_paid_only,
                     COALESCE(pd.n, 0) AS paid_count, COALESCE(pd.payees, 0) AS paid_payees, round(COALESCE(pd.amount, 0), 2) AS paid_amount,
                     COALESCE(u.n, 0) AS unpaid_count, round(COALESCE(u.amount, 0), 2) AS unpaid_amount, COALESCE(u.items, '[]'::jsonb) AS unpaid_items
                FROM products p LEFT JOIN paid pd ON pd.product = p.product LEFT JOIN unpaid u ON u.product_key = p.unpaid_key),
    -- ── Investigation items: reported only, never in paid or unpaid totals, never payables ──
    run AS (SELECT l.run_id FROM commission_recompute_lines l GROUP BY l.run_id ORDER BY min(l.created_at) DESC LIMIT 1),
    rc AS (SELECT l.earner_id, sum(l.amount) FILTER (WHERE l.line_kind = 'legacy_paid') AS legacy_paid, sum(l.amount) FILTER (WHERE l.line_kind = 'deserved') AS deserved
             FROM commission_recompute_lines l WHERE l.run_id = (SELECT run_id FROM run) AND l.earner_path = 'promissory_note' GROUP BY l.earner_id),
    note_audit AS (SELECT n.id, n.agent_id, n.approved_at, a.pso_excluded
                     FROM promissory_notes n
                     CROSS JOIN LATERAL (SELECT COALESCE((al.metadata ->> 'pso_bonus_excluded') = 'true', false) AS pso_excluded
                                           FROM audit_logs al
                                          WHERE al.table_name = 'promissory_notes' AND al.record_id = n.id::text AND al.action = 'approve_promissory_note'
                                          ORDER BY al.created_at DESC LIMIT 1) a
                    WHERE n.approval_bonus_paid),
    bonus_paid AS (SELECT DISTINCT g.source_id AS note_id, g.amount FROM general_ledger g
                    WHERE g.source_table = 'promissory_notes' AND g.ledger_scope = 'wallet' AND g.direction = 'cash_in'
                      AND g.idempotency_key = 'promissory_note_verified:' || g.source_id::text),
    unresolved AS (SELECT f.amount,
                          round(f.amount * COALESCE(promissory_commission_rate(CASE WHEN commission_partner_has_prior_fund_in(f.partner_id, f.fund_in_key, f.occurred_at)
                                                                                    THEN 'portfolio_topup' ELSE 'portfolio_creation' END, f.occurred_at), 0)) AS at_rate
                     FROM commission_fund_ins f
                    WHERE f.status = 'unattributed'
                      AND NOT EXISTS (SELECT 1 FROM unpaid_lines u WHERE u.source_table = 'commission_fund_ins' AND u.item_id = f.id)
                      AND NOT EXISTS (SELECT 1 FROM general_ledger g WHERE g.idempotency_key = 'fund_in_commission:' || f.fund_in_key)
                      AND NOT (f.fund_in_key LIKE 'pwo:%' AND EXISTS (SELECT 1 FROM pending_wallet_operations w
                                WHERE w.id::text = split_part(f.fund_in_key, ':', 2)
                                  AND w.created_at < (SELECT s.cutover_at FROM commission_gate_settings s WHERE s.id)))),
    cand AS (SELECT c.amount, r.earner_path
               FROM commission_fund_in_candidates c
               LEFT JOIN LATERAL (SELECT e.earner_path FROM commission_resolve_earner(c.partner_id, c.observed_at, true) e LIMIT 1) r ON true
              WHERE c.state IN ('needs_review', 'pending'))
    SELECT jsonb_build_object(
      'category', 'Partner Products and Services',
      'section', 'Proxy Agent Promissory Note Commissions',
      'as_at', now(),
      'paid_period', jsonb_build_object('from', p_from, 'to', p_to),
      'basis', jsonb_build_object(
        'paid', 'Credited to the payee''s wallet (general ledger wallet credit), net of reversals. A credited commission is a wallet balance, not a payable.',
        'unpaid', 'Confirmed unpaid only: the system recorded the commission as due, the Proxy Agent is known and no wallet credit exists. These are the Partner payables lines with the same product keys, so they are already inside the payables total.',
        'not_confirmed', 'A confirmed unpaid figure of zero does NOT mean nothing else can be owed. Fund-ins without an attributed introducer and deposits awaiting confirmation are listed under investigation items: their eligibility and amount are not yet confirmed, so they are excluded from every payable total until they are.',
        'withdrawals', 'Withdrawals of commission from wallets (agent commission payouts) are not counted here; they are Agent Products and Services payables.',
        'investigation', 'Investigation items are information only: not paid, not unpaid, not payables, and in no total.'),
      'lines', (SELECT jsonb_agg(jsonb_build_object('key', product, 'label', label, 'rule', rule, 'historical_paid_only', historical_paid_only,
                                                     'paid', jsonb_build_object('count', paid_count, 'payees', paid_payees, 'amount', paid_amount),
                                                     'unpaid', jsonb_build_object('count', unpaid_count, 'amount', unpaid_amount, 'items', unpaid_items))
                                 ORDER BY sort_order) FROM lines),
      'totals', (SELECT jsonb_build_object(
          'commissions_paid', sum(paid_amount) FILTER (WHERE product IN ('registration_bonus', 'fulfilment_commission', 'topup_commission')),
          'recalculation_topups_paid_historical', sum(paid_amount) FILTER (WHERE product = 'recalculation_topup'),
          'commissions_unpaid_confirmed', sum(unpaid_amount) FILTER (WHERE product IN ('registration_bonus', 'fulfilment_commission', 'topup_commission')),
          'lead_override_paid', sum(paid_amount) FILTER (WHERE product = 'lead_override'),
          'lead_override_unpaid_confirmed', sum(unpaid_amount) FILTER (WHERE product = 'lead_override'),
          'unpaid_in_payables', (SELECT round(COALESCE(sum(outstanding_amount), 0), 2) FROM unpaid_lines)) FROM lines),
      'investigation_items', jsonb_build_array(
        jsonb_build_object('key', 'historical_overpayments', 'label', 'Historical overpayments (commission recalculation ' || COALESCE((SELECT run_id FROM run), 'none') || ')',
          'earners', (SELECT count(*) FROM rc WHERE COALESCE(legacy_paid, 0) > COALESCE(deserved, 0)),
          'amount', (SELECT COALESCE(sum(COALESCE(legacy_paid, 0) - COALESCE(deserved, 0)), 0) FROM rc WHERE COALESCE(legacy_paid, 0) > COALESCE(deserved, 0)),
          'by_reason', (SELECT COALESCE(jsonb_object_agg(reason, amt), '{}'::jsonb) FROM (
                          SELECT CASE l.reason WHEN 'duplicate_of_topup' THEN 'top_up_paid_twice' WHEN 'roi_compounding' THEN 'reinvested_returns_counted_as_top_up'
                                   ELSE 'top_up_never_completed' END AS reason, sum(l.amount) AS amt FROM commission_recompute_lines l
                           WHERE l.run_id = (SELECT run_id FROM run) AND l.earner_path = 'promissory_note' AND l.line_kind = 'legacy_paid'
                             AND l.reason IN ('duplicate_of_topup', 'roi_compounding', 'topup_never_completed') GROUP BY l.reason) x)),
        jsonb_build_object('key', 'deleted_note_bonuses', 'label', 'Bonuses still credited on promissory notes that were later deleted',
          'registration_bonus', (SELECT jsonb_build_object('notes', count(*), 'amount', COALESCE(sum(g.amount), 0)) FROM general_ledger g
                                  WHERE g.source_table = 'promissory_notes' AND g.ledger_scope = 'wallet' AND g.direction = 'cash_in'
                                    AND g.idempotency_key = 'promissory_note_verified:' || g.source_id::text
                                    AND NOT EXISTS (SELECT 1 FROM promissory_notes n WHERE n.id = g.source_id)),
          'lead_override', (SELECT jsonb_build_object('notes', count(*), 'amount', COALESCE(sum(g.amount), 0)) FROM general_ledger g
                             WHERE g.source_table = 'promissory_notes' AND g.ledger_scope = 'wallet' AND g.direction = 'cash_in'
                               AND g.idempotency_key = 'promissory_note_lead:' || g.source_id::text
                               AND NOT EXISTS (SELECT 1 FROM promissory_notes n WHERE n.id = g.source_id))),
        jsonb_build_object('key', 'sales_officer_cases', 'label', 'Platform Sales Officer eligibility cases',
          'excluded_at_approval_not_officer_now', (SELECT jsonb_build_object('notes', count(*), 'bonus_if_eligible', COALESCE(sum(partner_note_rate('agent', na.approved_at)), 0))
                                                     FROM note_audit na WHERE na.pso_excluded
                                                      AND NOT EXISTS (SELECT 1 FROM bonus_paid b WHERE b.note_id = na.id)
                                                      AND NOT EXISTS (SELECT 1 FROM v_pso_officers o WHERE o.user_id = na.agent_id)),
          'credited_officer_now', (SELECT jsonb_build_object('notes', count(*), 'amount', COALESCE(sum(b.amount), 0))
                                     FROM promissory_notes n JOIN bonus_paid b ON b.note_id = n.id
                                    WHERE EXISTS (SELECT 1 FROM v_pso_officers o WHERE o.user_id = n.agent_id))),
        jsonb_build_object('key', 'unconfirmed_deposits', 'label', 'Deposits awaiting confirmation as top-ups (promissory-note partners)',
          'status', 'Eligibility and amount not confirmed; excluded from all payable totals until confirmed',
          'deposits', (SELECT count(*) FROM cand WHERE earner_path = 'promissory_note'),
          'amount', (SELECT COALESCE(sum(amount), 0) FROM cand WHERE earner_path = 'promissory_note'),
          'commission_if_confirmed', (SELECT COALESCE(round(sum(amount) * COALESCE(promissory_commission_rate('portfolio_topup', now()), 0)), 0) FROM cand WHERE earner_path = 'promissory_note'),
          'introducer_not_found', (SELECT jsonb_build_object('deposits', count(*), 'amount', COALESCE(sum(amount), 0)) FROM cand WHERE earner_path IS NULL)),
        jsonb_build_object('key', 'unattributed_fund_ins', 'label', 'Fund-ins awaiting introducer attribution',
          'status', 'Eligibility and amount not confirmed: no Proxy Agent is attributed yet, so these may or may not carry a commission. Excluded from all payable totals until attributed and confirmed',
          'fund_ins', (SELECT count(*) FROM unresolved),
          'amount', (SELECT COALESCE(sum(amount), 0) FROM unresolved),
          'commission_if_eligible', (SELECT COALESCE(sum(at_rate), 0) FROM unresolved)))
    )
  );
END
$function$;
REVOKE ALL ON FUNCTION public.get_partner_promissory_commissions(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_partner_promissory_commissions(date, date) TO authenticated, service_role;

RESET lock_timeout;
