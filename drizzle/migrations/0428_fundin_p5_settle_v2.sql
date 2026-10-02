-- FUNDIN-P5 v2. Approved: Bwayo (HR Lead), 2 Oct 2026, on executive authority.
-- Pays positive per-agent nets from recompute run R2026-10-A (full amount deployed, 2% first / 1% repeat fund-in,
-- one earner per fund-in). Expected: 12 agents, UGX 242,951. Overpayments are NOT touched here.
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='user_roles' AND column_name='enabled') THEN
    RAISE EXCEPTION 'FINGERPRINT FAIL: not the RentFlow database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.commission_recompute_lines WHERE run_id = 'R2026-10-A') THEN
    RAISE EXCEPTION 'PRECONDITION FAIL: recompute run R2026-10-A not found';
  END IF;
END $pre$;

CREATE TABLE IF NOT EXISTS public.commission_recompute_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL,
  earner_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('credit','debit')),
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('posted','unrecovered')),
  ledger_group_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, earner_id, direction)
);
ALTER TABLE public.commission_recompute_settlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commission_recompute_settlements_exec_read ON public.commission_recompute_settlements;
CREATE POLICY commission_recompute_settlements_exec_read ON public.commission_recompute_settlements FOR SELECT TO authenticated USING (
  public.hr_is_admin() OR public.hr_is_executive() OR EXISTS (
    SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.enabled = true
      AND ur.role = ANY (ARRAY['ceo'::app_role,'cfo'::app_role,'coo'::app_role,'super_admin'::app_role])));
GRANT SELECT ON public.commission_recompute_settlements TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.commission_recompute_settlements FROM anon, authenticated;

DO $p5$
DECLARE
  r record; v_idem text; v_group uuid; v_sid uuid; v_total numeric; v_n int;
  v_run constant text := 'R2026-10-A';
  v_expected_total constant numeric := 242951;
  v_expected_n constant int := 12;
BEGIN
  SELECT coalesce(sum(round(net)),0), count(*) INTO v_total, v_n
    FROM public.v_commission_recompute_summary WHERE run_id = v_run AND net >= 1;
  IF v_total <> v_expected_total OR v_n <> v_expected_n THEN
    RAISE EXCEPTION 'owed total % across % agents does not match the approved UGX 242,951 across 12 — nothing paid', v_total, v_n;
  END IF;

  FOR r IN SELECT earner_id, round(net) AS amt FROM public.v_commission_recompute_summary
            WHERE run_id = v_run AND net >= 1 ORDER BY earner_id LOOP
    v_idem := 'commission_recompute_settlement:' || v_run || ':credit:' || r.earner_id;
    IF EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key = v_idem) THEN CONTINUE; END IF;
    v_sid := gen_random_uuid();
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object('user_id', r.earner_id, 'amount', r.amt, 'direction','cash_out', 'category','marketing_expense',
          'source_table','commission_recompute_settlements', 'source_id', v_sid::text, 'reference_id', v_idem,
          'ledger_scope','platform', 'description','Marketing expense: commission correction (' || v_run || ')'),
        jsonb_build_object('user_id', r.earner_id, 'amount', r.amt, 'direction','cash_in', 'category','agent_commission',
          'source_table','commission_recompute_settlements', 'source_id', v_sid::text, 'reference_id', v_idem,
          'ledger_scope','wallet', 'recipient_type','user',
          'description','Commission correction: full amount deployed, 2% first / 1% repeat fund-in (' || v_run || ')')),
      v_idem);
    INSERT INTO public.commission_recompute_settlements (id, run_id, earner_id, direction, amount, status, ledger_group_id)
    VALUES (v_sid, v_run, r.earner_id, 'credit', r.amt, 'posted', v_group);

    -- Officers' PSO report shows the correction in commission accrued
    IF EXISTS (SELECT 1 FROM public.v_pso_officers o WHERE o.user_id = r.earner_id) THEN
      INSERT INTO public.promissory_commission_events
        (agent_id, kind, base_amount, rate, amount, source_table, source_id, idempotency_key, ledger_group_id, status)
      VALUES (r.earner_id, 'recompute_adjustment', 0, 0, r.amt, 'commission_recompute_settlements', v_sid::text, v_idem, v_group, 'paid');
    END IF;
  END LOOP;

  -- Pending legacy proxy items are superseded: their deserved value is inside this recompute.
  UPDATE public.proxy_commission_queue
     SET status = 'rejected', decided_at = now(),
         decision_note = 'superseded_by_fund_in_gate; settled in recompute ' || v_run
   WHERE status = 'pending'
     AND created_at < (SELECT cutover_at FROM public.commission_gate_settings WHERE id);
END $p5$;

SELECT pr.full_name, s.amount, s.status,
       (SELECT count(*) FROM public.general_ledger g WHERE g.transaction_group_id = s.ledger_group_id) AS ledger_rows
  FROM public.commission_recompute_settlements s
  JOIN public.profiles pr ON pr.id = s.earner_id
 WHERE s.run_id = 'R2026-10-A' AND s.direction = 'credit'
 ORDER BY s.amount DESC;