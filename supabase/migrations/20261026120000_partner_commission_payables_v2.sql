-- 2026-10-26: Partner Products and Services commission payables v2 (CFO policy of 2026-10-26). REPORTING ONLY.
--
-- What counts as a FIRM payable (v_partner_commission_payable_lines, summed into v_payables_lines):
--   Fund-in commission  (2% first fund-in / 1% later fund-ins, rates from promissory_commission_rates)
--       a commission_fund_ins row in 'unattributed' or 'no_earner' whose earner now resolves
--       (commission_resolve_earner: promissory-note agent OR managed proxy agent), earner not frozen, and no
--       commission was ever credited for it (gate key fund_in_commission:<key>, or a paid pre-gate queue/event row).
--       'no_earner' stays payable: a commission is not forfeited because its earner is identified after the
--       60-day retry window. Pre-gate top-ups and 'not_commissionable' rows are excluded. Only the Partner's first
--       fund-in earns the first-fund-in rate; an equal-time sibling with the lower key is the first one.
--       Speed: the hourly job (commission_reconcile_fund_ins) re-resolves and pays every 'unattributed' row, and a
--       note approval triggers an immediate catch-up, so the earner is looked up here only for rows the job is not
--       keeping current ('no_earner', never attempted, or last attempted over 90 minutes ago). A row checked in the
--       last 90 minutes is contingent until the next hourly run (worst case ~1 hour, managed-proxy approvals only).
--   UGX note bonus (partner_note_rate('agent') at approval)
--       every approved, unreversed note whose agent was not a Platform Sales Officer on the approval date
--       (HR assignment history), with no exclusion recorded at approval, and no wallet credit
--       promissory_note_verified:<note>. The approval audit record is no longer required.
--   UGX lead override (partner_note_rate('lead') at approval)
--       every approved, unreversed note whose agent had a lead assigned on the approval date, where the override
--       row is failed, skipped or missing, and no wallet credit promissory_note_lead:<note> exists.
-- What is CONTINGENT, never in any total (get_partner_commission_contingent()):
--   fund-ins with no identifiable earner, fund-ins whose earner is frozen, and fund-in candidates awaiting CFO review.
--
-- No ledger entry, wallet, payout, balance or financial record is written. The hourly commission job and the
-- payment functions are NOT changed: a 'no_earner' commission shown here is still not paid automatically.
-- Every non-commission branch of v_payables_lines is kept byte-for-byte (live definition md5 3f3b80188ccf4260e94b655ae58acadb).
-- Access: v_partner_commission_payable_lines is service_role only (like v_payables_lines);
-- get_partner_commission_contingent() checks payables_guard() and is granted to authenticated and service_role.
-- TRANSACTION: run as ONE transaction (by hand: BEGIN; ... COMMIT;). The precondition changes nothing when it refuses.
-- Rollback: supabase/rollbacks/20261026120000_partner_commission_payables_v2.rollback.sql
-- Tests: scripts/test-partner-commission-payables.mjs (PGlite) + read-only production checks.

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regclass('public.v_partner_commission_payable_lines') IS NOT NULL
     OR to_regproc('public.get_partner_commission_contingent') IS NOT NULL
     OR to_regclass('public.v_payables_lines') IS NULL
     OR md5(replace(pg_get_viewdef('public.v_payables_lines'::regclass), chr(13), '')) IS DISTINCT FROM '3f3b80188ccf4260e94b655ae58acadb'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.commission_resolve_earner(uuid,timestamp with time zone,boolean)'::regprocedure) IS DISTINCT FROM '30ead6239245687f6cac45b150966979'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.commission_partner_has_prior_fund_in(uuid,text,timestamp with time zone)'::regprocedure) IS DISTINCT FROM 'e244b3046118a291955bbbb2d4775dd7'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.promissory_commission_rate(text,timestamp with time zone)'::regprocedure) IS DISTINCT FROM '9cc2a51595b675711252a353549c2ddc'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.partner_note_rate(text,timestamp with time zone)'::regprocedure) IS DISTINCT FROM '29cf010439fa07464a84a6ed6a2a4a5e'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.payables_guard()'::regprocedure) IS DISTINCT FROM '9c689067513252c28fa5f61be3fde296' THEN
    RAISE EXCEPTION 'precondition failed: objects already exist, or the payables view / commission helpers changed since 2026-10-26; nothing was changed';
  END IF;
END
$pre$;

-- BEGIN FIRM VIEW
CREATE VIEW public.v_partner_commission_payable_lines AS
 WITH gate AS (
         SELECT s.cutover_at
           FROM commission_gate_settings s
          WHERE s.id
        ), fund_open AS (
         -- Fund-ins whose commission is still outstanding: never credited, not ruled out, not a pre-gate
         -- top-up, and not paid by the pre-gate engines. 'no_earner' stays in scope: a commission is not
         -- forfeited because its earner is identified after the 60-day retry window.
         SELECT f.id,
            f.partner_id,
            f.fund_in_key,
            f.amount,
            f.occurred_at,
            f.status,
            f.created_at,
            f.last_attempt_at
           FROM commission_fund_ins f
          WHERE (f.status = ANY (ARRAY['unattributed'::text, 'no_earner'::text]))
            AND f.amount > 0::numeric
            AND NOT (f.fund_in_key ~~ 'pwo:%'::text AND (EXISTS ( SELECT 1
                   FROM pending_wallet_operations w, gate
                  WHERE w.id::text = split_part(f.fund_in_key, ':'::text, 2) AND w.created_at < gate.cutover_at)))
            AND NOT (EXISTS ( SELECT 1
                   FROM general_ledger gl
                  WHERE gl.idempotency_key = ('fund_in_commission:'::text || f.fund_in_key)))
            AND NOT (EXISTS ( SELECT 1
                   FROM proxy_commission_queue q
                  WHERE q.source_id::text = split_part(f.fund_in_key, ':'::text, 2) AND q.status = 'paid'::text))
            AND NOT (EXISTS ( SELECT 1
                   FROM promissory_commission_events e
                  WHERE e.source_id::text = split_part(f.fund_in_key, ':'::text, 2) AND e.status = 'paid'::text))
        ), fund_lines AS (
         SELECT f.id,
            f.status,
            f.occurred_at,
            f.created_at,
            r.earner_id,
            r.earner_path,
            k.kind,
            round(f.amount * COALESCE(promissory_commission_rate(k.kind, f.occurred_at), 0::numeric)) AS commission
           FROM fund_open f
             CROSS JOIN LATERAL ( SELECT e.earner_id,
                    e.earner_path
                   FROM commission_resolve_earner(f.partner_id, f.occurred_at, true) e(earner_id, earner_path, note_id, assignment_id, basis)
                  -- The hourly job (commission_reconcile_fund_ins) resolves and pays every 'unattributed' row; a row it
                  -- checked in the last 90 minutes had no earner then. Re-resolve only rows the job is not keeping
                  -- current: 'no_earner' (no longer retried), never attempted, or last attempted over 90 minutes ago.
                  WHERE f.status = 'no_earner'::text OR f.last_attempt_at IS NULL OR f.last_attempt_at < (now() - '01:30:00'::interval)
                 LIMIT 1) r
             CROSS JOIN LATERAL ( SELECT
                        CASE
                            -- 2% only on the Partner's first fund-in; an equal-time sibling with a lower key is first.
                            WHEN commission_partner_has_prior_fund_in(f.partner_id, f.fund_in_key, f.occurred_at)
                              OR (EXISTS ( SELECT 1
                                   FROM commission_fund_ins s
                                  WHERE s.partner_id = f.partner_id AND s.status <> 'not_commissionable'::text
                                    AND s.occurred_at = f.occurred_at AND s.fund_in_key < f.fund_in_key)) THEN 'portfolio_topup'::text
                            ELSE 'portfolio_creation'::text
                        END AS kind) k
          WHERE r.earner_id IS NOT NULL
            AND NOT (EXISTS ( SELECT 1
                   FROM profiles fz
                  WHERE fz.id = r.earner_id AND COALESCE(fz.is_frozen, false)))
        ), note_bonus AS (
         -- UGX note bonus: due on every approved, unreversed note at the agent rate in force at approval,
         -- unless the agent was a Platform Sales Officer then (officer list, or the exclusion recorded at approval).
         SELECT n.id,
            n.agent_id,
            n.approved_at,
            n.created_at,
            partner_note_rate('agent'::text, n.approved_at) AS bonus
           FROM promissory_notes n
          WHERE n.approved_at IS NOT NULL AND n.agent_id IS NOT NULL
            AND COALESCE(n.status, ''::text) <> 'rejected'::text
            AND NOT (EXISTS ( SELECT 1
                   FROM partner_note_reversals v
                  WHERE v.note_id = n.id AND v.payee_role = 'agent'::text))
            AND NOT (EXISTS ( SELECT 1
                   FROM pso_note_reversals pr
                  WHERE pr.note_id = n.id))
            AND NOT (EXISTS ( SELECT 1
                   FROM hr_staff hs
                     JOIN hr_assignments ha ON ha.staff_id = hs.id
                     JOIN hr_positions hp ON hp.id = ha.position_id
                  WHERE hs.user_id = n.agent_id
                    AND (hp.key = 'platform_sales_officer'::text OR lower(btrim(hp.title)) = 'platform sales officer'::text)
                    AND ha.started_on <= (n.approved_at AT TIME ZONE 'Africa/Kampala'::text)::date
                    AND (ha.ended_on IS NULL OR ha.ended_on > (n.approved_at AT TIME ZONE 'Africa/Kampala'::text)::date)
                    AND (hs.ended_on IS NULL OR hs.ended_on > (n.approved_at AT TIME ZONE 'Africa/Kampala'::text)::date)))
            AND NOT (EXISTS ( SELECT 1
                   FROM audit_logs al
                  WHERE al.table_name = 'promissory_notes'::text AND al.record_id = n.id::text
                    AND al.action = 'approve_promissory_note'::text AND (al.metadata ->> 'pso_bonus_excluded'::text) = 'true'::text))
            AND NOT (EXISTS ( SELECT 1
                   FROM general_ledger gl
                  WHERE gl.idempotency_key = ('promissory_note_verified:'::text || n.id::text)
                    AND gl.ledger_scope = 'wallet'::text AND gl.direction = 'cash_in'::text))
        ), lead_due AS (
         -- UGX lead override: due when the agent had an active lead at approval (failed or missing override row)
         -- and the lead was never credited for the note.
         SELECT n.id,
            n.approved_at,
            n.created_at,
            COALESCE(o.lead_user_id, la.lead_user_id) AS lead_user_id,
            partner_note_rate('lead'::text, n.approved_at) AS amount,
            CASE WHEN o.id IS NULL THEN 'override_row_missing'::text ELSE 'override_' || o.status END AS status
           FROM promissory_notes n
             LEFT JOIN partner_note_overrides o ON o.note_id = n.id
             CROSS JOIN LATERAL ( SELECT a.lead_user_id
                   FROM partner_lead_assignments a
                  WHERE a.agent_id = n.agent_id AND a.attached_at <= n.approved_at
                    AND (a.detached_at IS NULL OR a.detached_at > n.approved_at)
                  ORDER BY a.attached_at DESC
                 LIMIT 1) la
          WHERE n.approved_at IS NOT NULL AND n.agent_id IS NOT NULL
            AND COALESCE(n.status, ''::text) <> 'rejected'::text
            AND NOT (EXISTS ( SELECT 1
                   FROM partner_note_reversals v
                  WHERE v.note_id = n.id AND v.payee_role = 'lead'::text))
            AND NOT (EXISTS ( SELECT 1
                   FROM general_ledger gl
                  WHERE gl.idempotency_key = ('promissory_note_lead:'::text || n.id::text)
                    AND gl.ledger_scope = 'wallet'::text AND gl.direction = 'cash_in'::text))
        )
 SELECT 'partner'::text AS category_key,
    'Partner Products and Services'::text AS category_label,
        CASE fl.kind
            WHEN 'portfolio_creation'::text THEN 'proxy_note_fulfilment_commission'::text
            ELSE 'proxy_note_topup_commission'::text
        END AS product_key,
        CASE fl.kind
            WHEN 'portfolio_creation'::text THEN 'Partner first fund-in commission — unpaid'::text
            ELSE 'Partner top-up commission — unpaid'::text
        END AS product_label,
    'commission_fund_ins'::text AS source_table,
    fl.id AS item_id,
    fl.earner_id AS counterparty_id,
    COALESCE(pe.full_name, 'Unknown earner'::text) AS counterparty_name,
    fl.commission AS outstanding_amount,
    (fl.occurred_at AT TIME ZONE 'Africa/Kampala'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
        CASE fl.status
            WHEN 'no_earner'::text THEN 'earner_identified_late'::text
            ELSE 'earner_resolved_unpaid'::text
        END AS status,
    fl.created_at
   FROM fund_lines fl
     LEFT JOIN profiles pe ON pe.id = fl.earner_id
  WHERE fl.commission > 0::numeric
UNION ALL
 SELECT 'partner'::text AS category_key,
    'Partner Products and Services'::text AS category_label,
    'proxy_note_registration_bonus'::text AS product_key,
    'Proxy Agent promissory note registration bonus — unpaid'::text AS product_label,
    'promissory_notes'::text AS source_table,
    nb.id AS item_id,
    nb.agent_id AS counterparty_id,
    COALESCE(pa.full_name, 'Unknown proxy agent'::text) AS counterparty_name,
    nb.bonus AS outstanding_amount,
    (nb.approved_at AT TIME ZONE 'Africa/Kampala'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    'verified_bonus_not_credited'::text AS status,
    nb.created_at
   FROM note_bonus nb
     LEFT JOIN profiles pa ON pa.id = nb.agent_id
  WHERE nb.bonus > 0::numeric
UNION ALL
 SELECT 'partner'::text AS category_key,
    'Partner Products and Services'::text AS category_label,
    'proxy_lead_override'::text AS product_key,
    'Proxy Agent lead override — unpaid'::text AS product_label,
    'promissory_notes'::text AS source_table,
    ld.id AS item_id,
    ld.lead_user_id AS counterparty_id,
    COALESCE(pl.full_name, 'Unknown lead'::text) AS counterparty_name,
    ld.amount AS outstanding_amount,
    (ld.approved_at AT TIME ZONE 'Africa/Kampala'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    ld.status,
    ld.created_at
   FROM lead_due ld
     LEFT JOIN profiles pl ON pl.id = ld.lead_user_id
  WHERE ld.amount > 0::numeric AND ld.lead_user_id IS NOT NULL;
-- END FIRM VIEW

REVOKE ALL ON public.v_partner_commission_payable_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_partner_commission_payable_lines TO service_role;

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
    'Landlord Products and Services'::text AS category_label,
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
     LEFT JOIN ( VALUES ('marketing'::text,'marketing'::text,'Marketing Expenses'::text,'marketing_budget'::text,'Marketing Weekly Budgets'::text,'Marketing Budgets'::text), ('product_research_and_development'::text,'rnd'::text,'R&D (Research and Development)'::text,'rnd_budget'::text,'R&D Weekly Budgets'::text,'R&D Budgets'::text)) dm(department_key, category_key, category_label, product_key, product_label, overspent_label) ON dm.department_key = hd.key
  WHERE b.outstanding_amount > 0::numeric OR b.overspent
UNION ALL
 SELECT category_key, category_label, product_key, product_label, source_table, item_id, counterparty_id, counterparty_name, outstanding_amount, due_date, due_kind, daily_amount, status, created_at
   FROM v_partner_commission_payable_lines;

-- BEGIN CONTINGENT FUNCTION
CREATE FUNCTION public.get_partner_commission_contingent()
 RETURNS TABLE(kind text, reason text, item_id uuid, partner_id uuid, partner_name text, commission_kind text,
               base_amount numeric, potential_commission numeric, occurred_at timestamp with time zone, source_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  PERFORM public.payables_guard();
  RETURN QUERY
  WITH gate AS (
         SELECT s.cutover_at FROM public.commission_gate_settings s WHERE s.id
       ), fund_open AS (
         SELECT f.id, f.partner_id, f.fund_in_key, f.amount, f.occurred_at, f.status, f.last_attempt_at
           FROM public.commission_fund_ins f
          WHERE f.status IN ('unattributed', 'no_earner') AND f.amount > 0
            AND NOT (f.fund_in_key LIKE 'pwo:%' AND EXISTS (
                  SELECT 1 FROM public.pending_wallet_operations w, gate
                   WHERE w.id::text = split_part(f.fund_in_key, ':', 2) AND w.created_at < gate.cutover_at))
            AND NOT EXISTS (SELECT 1 FROM public.general_ledger gl WHERE gl.idempotency_key = 'fund_in_commission:' || f.fund_in_key)
            AND NOT EXISTS (SELECT 1 FROM public.proxy_commission_queue q
                             WHERE q.source_id::text = split_part(f.fund_in_key, ':', 2) AND q.status = 'paid')
            AND NOT EXISTS (SELECT 1 FROM public.promissory_commission_events e
                             WHERE e.source_id::text = split_part(f.fund_in_key, ':', 2) AND e.status = 'paid')
       ), fund_rows AS (
         SELECT f.*, r.earner_id,
                (r.earner_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.profiles fz WHERE fz.id = r.earner_id AND coalesce(fz.is_frozen, false))) AS earner_frozen,
                CASE WHEN public.commission_partner_has_prior_fund_in(f.partner_id, f.fund_in_key, f.occurred_at)
                       OR EXISTS (SELECT 1 FROM public.commission_fund_ins s
                                   WHERE s.partner_id = f.partner_id AND s.status <> 'not_commissionable'
                                     AND s.occurred_at = f.occurred_at AND s.fund_in_key < f.fund_in_key)
                     THEN 'portfolio_topup' ELSE 'portfolio_creation' END AS kind
           FROM fund_open f
           LEFT JOIN LATERAL (SELECT e.earner_id FROM public.commission_resolve_earner(f.partner_id, f.occurred_at, true)
                                     e(earner_id, earner_path, note_id, assignment_id, basis)
                               -- same re-resolve rule as v_partner_commission_payable_lines (rows the hourly job checked
                               -- in the last 90 minutes had no earner then)
                               WHERE f.status = 'no_earner' OR f.last_attempt_at IS NULL OR f.last_attempt_at < now() - interval '90 minutes'
                               LIMIT 1) r ON true
       )
  SELECT 'fund_in'::text,
         CASE WHEN fr.earner_id IS NULL THEN 'no_earner_identified' ELSE 'earner_frozen' END,
         fr.id, fr.partner_id, coalesce(pp.full_name, 'Unknown partner'), fr.kind, fr.amount,
         round(fr.amount * coalesce(public.promissory_commission_rate(fr.kind, fr.occurred_at), 0)),
         fr.occurred_at, fr.status
    FROM fund_rows fr
    LEFT JOIN public.profiles pp ON pp.id = fr.partner_id
   WHERE fr.earner_id IS NULL OR fr.earner_frozen
  UNION ALL
  -- Candidates the hourly matcher could not classify: the CFO decides whether they are fund-ins at all.
  SELECT 'fund_in_candidate'::text, 'awaiting_cfo_review'::text,
         c.id, c.partner_id, coalesce(pp.full_name, 'Unknown partner'),
         CASE WHEN public.commission_partner_has_prior_fund_in(c.partner_id, 'candidate:' || c.id::text, c.observed_at)
              THEN 'portfolio_topup' ELSE 'portfolio_creation' END,
         c.amount,
         round(c.amount * coalesce(public.promissory_commission_rate(
             CASE WHEN public.commission_partner_has_prior_fund_in(c.partner_id, 'candidate:' || c.id::text, c.observed_at)
                  THEN 'portfolio_topup' ELSE 'portfolio_creation' END, c.observed_at), 0)),
         c.observed_at, c.state
    FROM public.commission_fund_in_candidates c
    LEFT JOIN public.profiles pp ON pp.id = c.partner_id
   WHERE c.state = 'needs_review' AND c.amount > 0;
END
$function$;
-- END CONTINGENT FUNCTION

REVOKE ALL ON FUNCTION public.get_partner_commission_contingent() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_partner_commission_contingent() TO authenticated, service_role;

RESET lock_timeout;
