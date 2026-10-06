-- FUNDIN-P4 v4. Approved: Bwayo (HR Lead), 2 Oct 2026, on executive authority. Report only; moves no money.
-- v4: top-ups are dated by deposit time (merge job overwrites reviewed_at); approved-but-parked top-ups count;
--     anything the gate has already paid is excluded.
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='user_roles' AND column_name='enabled') THEN
    RAISE EXCEPTION 'FINGERPRINT FAIL: not the RentFlow database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commission_gate_settings WHERE id) THEN
    RAISE EXCEPTION 'PRECONDITION FAIL: fund-in gate (P2C) not applied';
  END IF;
  IF position('pre_gate_topup' in pg_get_functiondef('public.commission_pay_fund_in(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAIL: FUNDIN-HOTFIX-1 not applied';
  END IF;
END $pre$;

CREATE TABLE IF NOT EXISTS public.commission_recompute_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL,
  line_kind text NOT NULL CHECK (line_kind IN ('deserved','legacy_paid')),
  fund_in_key text,
  partner_id uuid,
  portfolio_id uuid,
  occurred_at timestamptz,
  base_amount numeric,
  principal_method text,
  earner_id uuid,
  earner_path text,
  kind text,
  rate numeric,
  amount numeric NOT NULL DEFAULT 0,
  legacy_table text,
  legacy_id uuid,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commission_recompute_lines_run_earner_idx ON public.commission_recompute_lines (run_id, earner_id);
CREATE INDEX IF NOT EXISTS commission_recompute_lines_run_key_idx ON public.commission_recompute_lines (run_id, fund_in_key);
ALTER TABLE public.commission_recompute_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commission_recompute_lines_exec_read ON public.commission_recompute_lines;
CREATE POLICY commission_recompute_lines_exec_read ON public.commission_recompute_lines FOR SELECT TO authenticated USING (
  public.hr_is_admin() OR public.hr_is_executive() OR EXISTS (
    SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.enabled = true
      AND ur.role = ANY (ARRAY['ceo'::app_role,'cfo'::app_role,'coo'::app_role,'super_admin'::app_role])));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.commission_recompute_lines FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.commission_recompute_history(p_run_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
DECLARE
  v_from constant timestamptz := '2026-08-21 00:00:00+00';
  v_to timestamptz;
  h record; v_e uuid; v_path text; v_note uuid; v_asg uuid; v_prior boolean; v_kind text; v_rate numeric;
BEGIN
  SELECT cutover_at INTO v_to FROM public.commission_gate_settings WHERE id;
  IF v_to IS NULL THEN RAISE EXCEPTION 'gate cutover not set'; END IF;
  IF EXISTS (SELECT 1 FROM public.commission_recompute_lines WHERE run_id = p_run_id) THEN
    RAISE EXCEPTION 'run % already exists', p_run_id;
  END IF;

  CREATE TEMP TABLE _fi ON COMMIT DROP AS
  SELECT 'pf:' || ip.id::text AS fund_in_key, ip.investor_id AS partner_id, ip.id AS portfolio_id,
         tc.true_created AS occurred_at, pr.amount AS base_amount, pr.method AS principal_method
    FROM public.investor_portfolios ip
    CROSS JOIN LATERAL (
      SELECT coalesce((SELECT min(r.old_created_at) FROM public.portfolio_renewals r WHERE r.portfolio_id = ip.id),
                      ip.created_at) AS true_created
    ) tc
    CROSS JOIN LATERAL (
      SELECT x.amount, x.method FROM (
        SELECT 1 AS ord, g.amount, 'ledger_at_creation'::text AS method
          FROM public.general_ledger g
         WHERE g.source_table = 'investor_portfolios' AND g.source_id = ip.id
           AND g.category = 'partner_funding' AND g.direction = 'cash_out' AND g.ledger_scope = 'wallet'
           AND abs(extract(epoch FROM g.transaction_date - tc.true_created)) < 600
        UNION ALL
        SELECT 2, q.base_amount, 'legacy_proxy_base'
          FROM public.proxy_commission_queue q
         WHERE q.kind = 'portfolio_creation' AND q.source_table = 'investor_portfolios' AND q.source_id = ip.id::text
        UNION ALL
        SELECT 3, pe.base_amount, 'legacy_precap_base'
          FROM public.promissory_commission_events pe
         WHERE pe.kind = 'portfolio_creation' AND pe.source_table = 'investor_portfolios' AND pe.source_id = ip.id::text
           AND pe.status = 'paid' AND pe.created_at < '2026-09-03 12:32:38+00'
        UNION ALL
        SELECT 4, ip.investment_amount, 'current_principal_unchanged'
         WHERE NOT EXISTS (SELECT 1 FROM public.pending_wallet_operations w
                            WHERE w.operation_type = 'portfolio_topup' AND w.status IN ('completed','approved') AND w.source_id = ip.id)
           AND NOT EXISTS (SELECT 1 FROM public.general_ledger g2
                            WHERE g2.source_table = 'investor_portfolios' AND g2.source_id = ip.id
                              AND g2.category IN ('roi_reinvestment','pending_portfolio_topup'))
           AND NOT EXISTS (SELECT 1 FROM public.portfolio_renewals r2 WHERE r2.portfolio_id = ip.id)
        UNION ALL
        SELECT 9, NULL::numeric, 'unresolved'
      ) x ORDER BY x.ord LIMIT 1
    ) pr
   WHERE ip.status IN ('active','locked') AND ip.locked_from_portfolio_id IS NULL
     AND tc.true_created >= v_from AND tc.true_created < v_to
     AND NOT public.hr_pay_is_staff_reinvest_portfolio(ip.id)
  UNION ALL
  SELECT 'pwo:' || w.id::text, coalesce(ip.investor_id, w.user_id), ip.id,
         w.created_at, w.amount, 'deposited_topup'
    FROM public.pending_wallet_operations w
    LEFT JOIN public.investor_portfolios ip ON w.source_table = 'investor_portfolios' AND ip.id = w.source_id
   WHERE w.operation_type = 'portfolio_topup' AND w.status IN ('completed','approved') AND coalesce(w.amount,0) > 0
     AND w.created_at >= v_from AND w.created_at < v_to
     AND (ip.id IS NULL OR NOT public.hr_pay_is_staff_reinvest_portfolio(ip.id))
  UNION ALL
  SELECT 'psc:' || s.id::text, s.partner_id, NULL::uuid, s.created_at, s.committed_amount, 'self_commitment'
    FROM public.partner_self_commitments s
   WHERE s.status IN ('active','matured') AND s.created_at >= v_from AND s.created_at < v_to
     AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip2
                      WHERE ip2.investor_id = s.partner_id AND ip2.investment_amount = s.committed_amount
                        AND abs(extract(epoch FROM ip2.created_at - s.created_at)) < 86400);

  -- Anything the gate has already paid is settled there, never here.
  DELETE FROM _fi f
   WHERE EXISTS (SELECT 1 FROM public.commission_fund_ins g WHERE g.fund_in_key = f.fund_in_key AND g.status = 'paid');

  CREATE TEMP TABLE _lock (partner_id uuid PRIMARY KEY, earner_id uuid, earner_path text, note_id uuid, assignment_id uuid) ON COMMIT DROP;

  FOR h IN SELECT * FROM _fi ORDER BY partner_id, occurred_at, fund_in_key LOOP
    IF h.base_amount IS NULL THEN
      INSERT INTO public.commission_recompute_lines (run_id, line_kind, fund_in_key, partner_id, portfolio_id, occurred_at, principal_method, amount, reason)
      VALUES (p_run_id, 'deserved', h.fund_in_key, h.partner_id, h.portfolio_id, h.occurred_at, h.principal_method, 0, 'needs_review_principal_unknown');
      CONTINUE;
    END IF;

    v_e := NULL; v_path := NULL; v_note := NULL; v_asg := NULL;
    SELECT l.earner_id, l.earner_path, l.note_id, l.assignment_id INTO v_e, v_path, v_note, v_asg
      FROM _lock l WHERE l.partner_id = h.partner_id;
    IF v_e IS NULL THEN
      SELECT r.earner_id, r.earner_path, r.note_id, r.assignment_id INTO v_e, v_path, v_note, v_asg
        FROM public.commission_resolve_earner(h.partner_id, h.occurred_at, false) r LIMIT 1;
      IF v_e IS NOT NULL THEN
        INSERT INTO _lock VALUES (h.partner_id, v_e, v_path, v_note, v_asg);
      END IF;
    END IF;

    v_prior := EXISTS (SELECT 1 FROM _fi f2 WHERE f2.partner_id = h.partner_id
                         AND f2.occurred_at < h.occurred_at AND f2.fund_in_key <> h.fund_in_key)
            OR public.commission_partner_has_prior_fund_in(h.partner_id, h.fund_in_key, h.occurred_at);
    v_kind := CASE WHEN v_prior THEN 'portfolio_topup' ELSE 'portfolio_creation' END;
    v_rate := public.promissory_commission_rate(v_kind, h.occurred_at);

    INSERT INTO public.commission_recompute_lines
      (run_id, line_kind, fund_in_key, partner_id, portfolio_id, occurred_at, base_amount, principal_method,
       earner_id, earner_path, kind, rate, amount, reason)
    VALUES (p_run_id, 'deserved', h.fund_in_key, h.partner_id, h.portfolio_id, h.occurred_at, h.base_amount, h.principal_method,
       v_e, v_path, v_kind, v_rate,
       CASE WHEN v_e IS NULL THEN 0 ELSE round(h.base_amount * v_rate) END,
       CASE WHEN v_e IS NULL THEN 'no_earner' ELSE 'deserved' END);
  END LOOP;

  INSERT INTO public.commission_recompute_lines
    (run_id, line_kind, fund_in_key, partner_id, occurred_at, base_amount, earner_id, earner_path, kind, rate, amount, legacy_table, legacy_id, reason)
  SELECT p_run_id, 'legacy_paid', k.fund_in_key, l.partner_id, l.created_at, l.base_amount, l.agent_id, l.path,
         l.kind, l.rate, l.amount, l.tbl, l.id, k.reason
    FROM (
      SELECT 'promissory_commission_events'::text AS tbl, pe.id, pe.partner_id, pe.agent_id, 'promissory_note'::text AS path,
             pe.kind, pe.base_amount, pe.rate, pe.amount, pe.source_table, pe.source_id, pe.created_at
        FROM public.promissory_commission_events pe
       WHERE pe.status = 'paid' AND pe.kind IN ('portfolio_creation','portfolio_topup') AND pe.created_at < v_to
         AND pe.idempotency_key NOT LIKE 'fund_in_commission:%'
      UNION ALL
      SELECT 'proxy_commission_queue', q.id, q.partner_id, q.agent_id, 'managed_proxy',
             q.kind, q.base_amount, q.rate, q.amount, q.source_table, q.source_id, q.created_at
        FROM public.proxy_commission_queue q
       WHERE q.status = 'paid' AND q.kind IN ('portfolio_creation','portfolio_topup') AND q.created_at < v_to
         AND q.idempotency_key NOT LIKE 'fund_in_commission:%'
    ) l
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN l.source_table = 'investor_portfolios' AND l.kind = 'portfolio_creation' THEN 'pf:' || l.source_id
               WHEN l.source_table = 'pending_wallet_operations' THEN 'pwo:' || l.source_id
               WHEN l.source_table = 'partner_self_commitments' THEN 'psc:' || l.source_id
               WHEN l.source_table = 'partner_self_topups' THEN 'pst:' || l.source_id
             END AS fund_in_key,
             CASE
               WHEN l.source_table = 'pending_wallet_operations' AND NOT EXISTS (
                      SELECT 1 FROM public.pending_wallet_operations w
                       WHERE w.id::text = l.source_id AND w.status IN ('completed','approved'))
                 THEN 'topup_never_completed'
               WHEN l.source_table = 'investor_portfolios' AND l.kind = 'portfolio_topup' AND EXISTS (
                      SELECT 1 FROM public.pending_wallet_operations w
                       WHERE w.operation_type = 'portfolio_topup' AND w.source_id::text = split_part(l.source_id, ':', 1)
                         AND w.amount = l.base_amount
                         AND w.created_at BETWEEN l.created_at - interval '35 days' AND l.created_at + interval '1 day')
                 THEN 'duplicate_of_topup'
               WHEN l.source_table = 'investor_portfolios' AND l.kind = 'portfolio_topup' AND EXISTS (
                      SELECT 1 FROM public.general_ledger g
                       WHERE g.user_id = l.partner_id AND g.category IN ('roi_reinvestment','roi_expense')
                         AND g.amount = l.base_amount
                         AND g.transaction_date BETWEEN l.created_at - interval '1 day' AND l.created_at + interval '1 day')
                 THEN 'roi_compounding'
               WHEN l.source_table = 'investor_portfolios' AND l.kind = 'portfolio_topup'
                 THEN 'unexplained_principal_increase'
               ELSE 'legacy_payment'
             END AS reason
    ) k;

  INSERT INTO public.commission_recompute_lines
    (run_id, line_kind, fund_in_key, partner_id, occurred_at, base_amount, earner_id, earner_path, kind, rate, amount, legacy_table, legacy_id, reason)
  SELECT run_id, 'deserved', fund_in_key, partner_id, occurred_at, base_amount, earner_id, earner_path, kind, rate, amount,
         legacy_table, legacy_id, 'held_neutral_needs_review'
    FROM public.commission_recompute_lines
   WHERE run_id = p_run_id AND line_kind = 'legacy_paid' AND reason = 'unexplained_principal_increase';

  INSERT INTO public.commission_recompute_lines
    (run_id, line_kind, fund_in_key, partner_id, occurred_at, base_amount, earner_id, earner_path, kind, rate, amount, legacy_table, legacy_id, reason)
  SELECT l.run_id, 'deserved', l.fund_in_key, l.partner_id, l.occurred_at, l.base_amount, l.earner_id, l.earner_path,
         l.kind, l.rate, l.amount, l.legacy_table, l.legacy_id, 'held_neutral_principal_unknown'
    FROM public.commission_recompute_lines l
   WHERE l.run_id = p_run_id AND l.line_kind = 'legacy_paid'
     AND EXISTS (SELECT 1 FROM public.commission_recompute_lines d
                  WHERE d.run_id = p_run_id AND d.line_kind = 'deserved'
                    AND d.fund_in_key = l.fund_in_key AND d.reason = 'needs_review_principal_unknown');

  RETURN (
    SELECT jsonb_build_object(
      'run_id', p_run_id, 'from', v_from, 'to', v_to,
      'deserved_total', coalesce(sum(amount) FILTER (WHERE line_kind='deserved'),0),
      'legacy_paid_total', coalesce(sum(amount) FILTER (WHERE line_kind='legacy_paid'),0),
      'lines_by_reason', (SELECT jsonb_object_agg(reason, n) FROM (
          SELECT reason, count(*) n FROM public.commission_recompute_lines WHERE run_id = p_run_id GROUP BY reason) r))
    FROM public.commission_recompute_lines WHERE run_id = p_run_id);
END $f$;
REVOKE ALL ON FUNCTION public.commission_recompute_history(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE VIEW public.v_commission_recompute_summary WITH (security_invoker = true) AS
SELECT run_id, earner_id,
       coalesce(sum(amount) FILTER (WHERE line_kind='deserved'),0)    AS deserved,
       coalesce(sum(amount) FILTER (WHERE line_kind='legacy_paid'),0) AS legacy_paid,
       coalesce(sum(amount) FILTER (WHERE line_kind='deserved'),0)
     - coalesce(sum(amount) FILTER (WHERE line_kind='legacy_paid'),0) AS net,
       count(*) FILTER (WHERE reason='roi_compounding')       AS roi_lines,
       count(*) FILTER (WHERE reason='duplicate_of_topup')    AS duplicate_lines,
       count(*) FILTER (WHERE reason='topup_never_completed') AS uncompleted_topup_lines
  FROM public.commission_recompute_lines
 WHERE earner_id IS NOT NULL
 GROUP BY run_id, earner_id;

SELECT public.commission_recompute_history('R2026-10-A');