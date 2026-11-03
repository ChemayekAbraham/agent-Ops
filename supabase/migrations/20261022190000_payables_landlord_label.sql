-- 2026-10-22: CFO correction -- payables category label typo. LABEL ONLY.
--   landlord  Land Products and Services  ->  Landlord Products and Services
-- Changed in the two places the label lives: payables_category_frame() and the two landlord branches of v_payables_lines.
-- Nothing else changes: same records, keys, product lines, amounts, dates, statuses, grants and attributes. No ledger,
-- wallet, payout, commission or historical record is touched. Follows 20261022180000_payables_categories_v2.
-- TRANSACTION: run the file as ONE transaction (the migration tool does; by hand, wrap it in BEGIN; ... COMMIT;). The
-- guard changes nothing when it refuses. Function checks ignore carriage returns (CRLF checkouts).
-- Rollback: supabase/rollbacks/20261022190000_payables_landlord_label.rollback.sql

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF md5(pg_get_viewdef('public.v_payables_lines'::regclass)) IS DISTINCT FROM '4af52d7dfefa669993bf77c3f8a30990'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.payables_category_frame()'::regprocedure) IS DISTINCT FROM 'd68d7533a2a3a955f06a66959be32246' THEN
    RAISE EXCEPTION 'precondition failed: v_payables_lines or payables_category_frame is not the 20261022180000_payables_categories_v2 version; nothing was changed. Regenerate this migration from the current definitions';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.payables_category_frame()
 RETURNS TABLE(category_key text, category_label text, sort_order integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT * FROM (VALUES
    ('partner','Partner Products and Services',1),
    ('landlord','Landlord Products and Services',2),
    ('agent','Agent Products and Services',3),
    ('budget','Operational Expenses',4),
    ('marketing','Marketing Expenses',5),
    ('rnd','R&D (Research and Development)',6),
    ('other','Unclassified / Other',7)
  ) f(category_key, category_label, sort_order)
$function$;

CREATE OR REPLACE VIEW public.v_payables_lines AS
SELECT 'partner'::text AS category_key,
    'Partner Products and Services'::text AS category_label,
    'supporter_returns'::text AS product_key,
    'Supporter Returns Due'::text AS product_label,
    'investor_portfolios'::text AS source_table,
    ip.id AS item_id,
    ip.investor_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown supporter'::text) AS counterparty_name,
    GREATEST(round(((COALESCE(ip.investment_amount, (0)::numeric) * COALESCE(ip.roi_percentage, (0)::numeric)) / 100.0), 2), (0)::numeric) AS outstanding_amount,
    ip.next_roi_date AS due_date,
    'scheduled'::text AS due_kind,
    (0)::numeric AS daily_amount,
    ip.status,
    ip.created_at
   FROM (investor_portfolios ip
     LEFT JOIN profiles p ON ((p.id = ip.investor_id)))
  WHERE ((ip.status = 'active'::text) AND (ip.next_roi_date IS NOT NULL) AND ((COALESCE(ip.investment_amount, (0)::numeric) * COALESCE(ip.roi_percentage, (0)::numeric)) > (0)::numeric))
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Products and Services'::text AS category_label,
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
    ('Landlord float, week of '::text || to_char((f.week_start)::timestamp without time zone, 'DD Mon YYYY'::text)) AS counterparty_name,
    f.outstanding_amount,
    f.week_end AS due_date,
    'scheduled'::text AS due_kind,
    (0)::numeric AS daily_amount,
        CASE
            WHEN f.overspent THEN 'overspent'::text
            WHEN f.week_ended THEN 'week_ended'::text
            WHEN (f.unverified_count > 0) THEN 'receipts_pending'::text
            ELSE 'open'::text
        END AS status,
    f.created_at
   FROM v_landlord_float_payables f
  WHERE ((f.outstanding_amount > (0)::numeric) OR f.overspent)
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Products and Services'::text AS category_label,
    'landlord_approved_no_float'::text AS product_key,
    'Landlord payouts approved outside a weekly float'::text AS product_label,
    'landlord_payouts'::text AS source_table,
    s.payout_id AS item_id,
    s.landlord_id AS counterparty_id,
    COALESCE(s.landlord_name, 'Unknown landlord'::text) AS counterparty_name,
    s.amount AS outstanding_amount,
    ((s.created_at AT TIME ZONE 'Africa/Kampala'::text))::date AS due_date,
    'scheduled'::text AS due_kind,
    (0)::numeric AS daily_amount,
        CASE
            WHEN ((s.no_float_basis = 'attempt_ended_unpaid'::text) AND (s.payout_status = 'failed'::text)) THEN 'payout_failed_unpaid'::text
            WHEN (s.no_float_basis = 'attempt_ended_unpaid'::text) THEN 'completed_without_payment'::text
            ELSE s.payout_status
        END AS status,
    s.created_at
   FROM v_landlord_payout_settlement s
  WHERE (s.approved_no_float AND (s.amount > (0)::numeric))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products and Services'::text AS category_label,
    'agent_commission_payout'::text AS product_key,
    'Agent Commission Payouts'::text AS product_label,
    'agent_commission_payouts'::text AS source_table,
    cp.id AS item_id,
    cp.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(cp.amount, (0)::numeric), (0)::numeric) AS outstanding_amount,
    ((cp.requested_at AT TIME ZONE 'Africa/Nairobi'::text))::date AS due_date,
    'scheduled'::text AS due_kind,
    (0)::numeric AS daily_amount,
    cp.status,
    cp.created_at
   FROM (agent_commission_payouts cp
     LEFT JOIN profiles p ON ((p.id = cp.agent_id)))
  WHERE ((cp.status = ANY (ARRAY['pending'::text, 'approved'::text])) AND (COALESCE(cp.amount, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT COALESCE(dm.category_key, 'budget'::text) AS category_key,
    COALESCE(dm.category_label, 'Operational Expenses'::text) AS category_label,
        CASE
            WHEN b.overspent THEN (COALESCE(dm.product_key, 'department_budget'::text) || '_overspent'::text)
            ELSE COALESCE(dm.product_key, 'department_budget'::text)
        END AS product_key,
        CASE
            WHEN b.overspent THEN (COALESCE(dm.overspent_label, 'Departmental Budgets'::text) || ' — overspent (credited above budget)'::text)
            ELSE COALESCE(dm.product_label, 'Departmental Weekly Budgets'::text)
        END AS product_label,
    'budget_submission_lines'::text AS source_table,
    b.line_id AS item_id,
    b.department_id AS counterparty_id,
    COALESCE(b.department_name, 'Unknown department'::text) AS counterparty_name,
    b.outstanding_amount,
    b.period_end AS due_date,
    'scheduled'::text AS due_kind,
    (0)::numeric AS daily_amount,
        CASE
            WHEN b.overspent THEN 'overspent'::text
            WHEN (b.unproven_credit_amount > (0)::numeric) THEN 'credit_unproven'::text
            ELSE b.submission_status
        END AS status,
    b.line_created_at AS created_at
   FROM ((v_budget_payables_lines b
     LEFT JOIN hr_departments hd ON ((hd.id = b.department_id)))
     LEFT JOIN ( VALUES ('marketing'::text,'marketing'::text,'Marketing Expenses'::text,'marketing_budget'::text,'Marketing Weekly Budgets'::text,'Marketing Budgets'::text), ('product_research_and_development'::text,'rnd'::text,'R&D (Research and Development)'::text,'rnd_budget'::text,'R&D Weekly Budgets'::text,'R&D Budgets'::text)) dm(department_key, category_key, category_label, product_key, product_label, overspent_label) ON ((dm.department_key = hd.key)))
  WHERE ((b.outstanding_amount > (0)::numeric) OR b.overspent)
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
    ((n.approved_at AT TIME ZONE 'Africa/Kampala'::text))::date AS due_date,
    'scheduled'::text AS due_kind,
    (0)::numeric AS daily_amount,
    'verified_bonus_not_credited'::text AS status,
    n.created_at
   FROM (((promissory_notes n
     LEFT JOIN ( SELECT DISTINCT gl.source_id
           FROM general_ledger gl
          WHERE ((gl.source_table = 'promissory_notes'::text) AND (gl.idempotency_key = ('promissory_note_verified:'::text || (gl.source_id)::text)) AND (gl.ledger_scope = 'wallet'::text) AND (gl.direction = 'cash_in'::text))) bp ON ((bp.source_id = n.id)))
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN ((al.metadata ->> 'bonus_amount'::text) ~ '^[0-9]+(\.[0-9]+)?$'::text) THEN ((al.metadata ->> 'bonus_amount'::text))::numeric
                    ELSE (0)::numeric
                END AS bonus
           FROM audit_logs al
          WHERE ((al.table_name = 'promissory_notes'::text) AND (al.record_id = (n.id)::text) AND (al.action = 'approve_promissory_note'::text))
          ORDER BY al.created_at DESC
         LIMIT 1) a)
     LEFT JOIN profiles pa ON ((pa.id = n.agent_id)))
  WHERE (n.approval_bonus_paid AND (bp.source_id IS NULL) AND (a.bonus > (0)::numeric))
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
    round((f.amount * rt.rate)) AS outstanding_amount,
    ((f.occurred_at AT TIME ZONE 'Africa/Kampala'::text))::date AS due_date,
    'scheduled'::text AS due_kind,
    (0)::numeric AS daily_amount,
    'awaiting_commission_gate'::text AS status,
    f.created_at
   FROM ((((commission_fund_ins f
     CROSS JOIN LATERAL ( SELECT e.earner_id,
            e.earner_path
           FROM commission_resolve_earner(f.partner_id, f.occurred_at, true) e(earner_id, earner_path, note_id, assignment_id, basis)
         LIMIT 1) r)
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN commission_partner_has_prior_fund_in(f.partner_id, f.fund_in_key, f.occurred_at) THEN 'portfolio_topup'::text
                    ELSE 'portfolio_creation'::text
                END AS kind) k)
     CROSS JOIN LATERAL ( SELECT COALESCE(promissory_commission_rate(k.kind, f.occurred_at), (0)::numeric) AS rate) rt)
     LEFT JOIN profiles pe ON ((pe.id = r.earner_id)))
  WHERE ((f.status = 'unattributed'::text) AND (EXISTS ( SELECT 1
           FROM commission_fund_ins pf
          WHERE ((pf.partner_id = f.partner_id) AND (pf.status = 'paid'::text)))) AND (r.earner_path = 'promissory_note'::text) AND (round((f.amount * rt.rate)) > (0)::numeric) AND (NOT ((f.fund_in_key ~~ 'pwo:%'::text) AND (EXISTS ( SELECT 1
           FROM pending_wallet_operations w
          WHERE (((w.id)::text = split_part(f.fund_in_key, ':'::text, 2)) AND (w.created_at < ( SELECT s.cutover_at
                   FROM commission_gate_settings s
                  WHERE s.id))))))) AND (NOT (EXISTS ( SELECT 1
           FROM general_ledger gl
          WHERE (gl.idempotency_key = ('fund_in_commission:'::text || f.fund_in_key))))))
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
    ((o.approved_at AT TIME ZONE 'Africa/Kampala'::text))::date AS due_date,
    'scheduled'::text AS due_kind,
    (0)::numeric AS daily_amount,
    'override_posting_failed'::text AS status,
    o.created_at
   FROM (partner_note_overrides o
     LEFT JOIN profiles pl ON ((pl.id = o.lead_user_id)))
  WHERE ((o.status = 'failed'::text) AND (o.amount > (0)::numeric) AND (o.lead_user_id IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
           FROM general_ledger gl
          WHERE ((gl.idempotency_key = ('promissory_note_lead:'::text || (o.note_id)::text)) AND (gl.ledger_scope = 'wallet'::text) AND (gl.direction = 'cash_in'::text))))));

RESET lock_timeout;
