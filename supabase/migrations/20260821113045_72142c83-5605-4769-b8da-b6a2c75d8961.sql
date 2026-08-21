-- ─────────────────────────────────────────────────────────────────────────────
-- Promissory → proxy agent commission engine
--   Rule 1 (UGX 1,500 on note approval) already lives in approve_promissory_note.
--   Rule 2: 2% of portfolio principal when a promissory-linked partner deploys.
--   Rule 3: 1% of the increase when that partner tops up.
-- Ledger-only. No wallet writes. Idempotent per source record.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.promissory_commission_rates (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('portfolio_creation','portfolio_topup')),
  rate numeric NOT NULL CHECK (rate >= 0 AND rate <= 1),
  effective_from timestamptz NOT NULL DEFAULT now(),
  set_by uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.promissory_commission_rates TO authenticated;
GRANT ALL ON public.promissory_commission_rates TO service_role;
ALTER TABLE public.promissory_commission_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pcr_read_staff" ON public.promissory_commission_rates;
CREATE POLICY "pcr_read_staff" ON public.promissory_commission_rates
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "pcr_manage_finance" ON public.promissory_commission_rates;
CREATE POLICY "pcr_manage_finance" ON public.promissory_commission_rates
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE ur.user_id = (SELECT auth.uid())
                    AND ur.role = ANY (ARRAY['cfo','manager','super_admin','ceo']::app_role[])))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE ur.user_id = (SELECT auth.uid())
                    AND ur.role = ANY (ARRAY['cfo','manager','super_admin','ceo']::app_role[])));

INSERT INTO public.promissory_commission_rates (kind, rate, effective_from, reason)
SELECT 'portfolio_creation', 0.02, '2026-01-01'::timestamptz,
       'Proxy agent earns 2% of portfolio principal when a promissory-linked partner deploys'
WHERE NOT EXISTS (SELECT 1 FROM public.promissory_commission_rates WHERE kind = 'portfolio_creation');

INSERT INTO public.promissory_commission_rates (kind, rate, effective_from, reason)
SELECT 'portfolio_topup', 0.01, '2026-01-01'::timestamptz,
       'Proxy agent earns 1% of the principal increase when a promissory-linked partner tops up'
WHERE NOT EXISTS (SELECT 1 FROM public.promissory_commission_rates WHERE kind = 'portfolio_topup');

CREATE OR REPLACE FUNCTION public.promissory_commission_rate(p_kind text, p_at timestamptz DEFAULT now())
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
  SELECT r.rate
    FROM public.promissory_commission_rates r
   WHERE r.kind = p_kind
     AND r.effective_from <= coalesce(p_at, now())
   ORDER BY r.effective_from DESC
   LIMIT 1
$$;

-- ── Audit trail (CFO + Partner Ops) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.promissory_commission_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  note_id uuid,
  agent_id uuid,
  partner_id uuid,
  kind text NOT NULL,
  base_amount numeric NOT NULL DEFAULT 0,
  rate numeric NOT NULL DEFAULT 0,
  amount numeric NOT NULL DEFAULT 0,
  source_table text NOT NULL,
  source_id text NOT NULL,
  idempotency_key text NOT NULL,
  ledger_group_id uuid,
  status text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','skipped','failed')),
  skip_reason text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS promissory_commission_events_idem_paid_idx
  ON public.promissory_commission_events (idempotency_key) WHERE status = 'paid';
CREATE INDEX IF NOT EXISTS promissory_commission_events_agent_idx
  ON public.promissory_commission_events (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS promissory_commission_events_partner_idx
  ON public.promissory_commission_events (partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS promissory_commission_events_note_idx
  ON public.promissory_commission_events (note_id, kind, status);

GRANT SELECT ON public.promissory_commission_events TO authenticated;
GRANT ALL ON public.promissory_commission_events TO service_role;
ALTER TABLE public.promissory_commission_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pce_read_finance_partner_ops" ON public.promissory_commission_events;
CREATE POLICY "pce_read_finance_partner_ops" ON public.promissory_commission_events
  FOR SELECT TO authenticated
  USING (
    agent_id = (SELECT auth.uid())
    OR partner_id = (SELECT auth.uid())
    OR EXISTS (SELECT 1 FROM public.user_roles ur
                WHERE ur.user_id = (SELECT auth.uid())
                  AND ur.role = ANY (ARRAY['cfo','coo','ceo','manager','super_admin',
                                           'partner_ops','financial_ops','operations','agent_ops']::app_role[]))
  );

-- ── Shared credit engine: single resolve query, ledger-only, idempotent ──────
CREATE OR REPLACE FUNCTION public.credit_promissory_agent_commission(
  p_partner_id uuid,
  p_base_amount numeric,
  p_kind text,
  p_source_table text,
  p_source_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
DECLARE
  v_note_id uuid;
  v_agent_id uuid;
  v_rate numeric;
  v_amount numeric;
  v_idem text;
  v_group uuid;
  v_label text;
BEGIN
  IF p_partner_id IS NULL OR coalesce(p_base_amount,0) <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','no_base_amount');
  END IF;

  SELECT n.id, n.agent_id
    INTO v_note_id, v_agent_id
    FROM public.promissory_notes n
   WHERE n.partner_user_id = p_partner_id
     AND n.agent_id IS NOT NULL
     AND coalesce(n.approval_bonus_paid, false) = true
   ORDER BY n.approved_at DESC NULLS LAST, n.created_at DESC
   LIMIT 1;

  IF v_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','partner_not_promissory_linked');
  END IF;

  v_rate := public.promissory_commission_rate(p_kind, now());
  IF coalesce(v_rate,0) <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','no_rate_in_force');
  END IF;

  v_amount := round(p_base_amount * v_rate);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','amount_rounds_to_zero');
  END IF;

  -- Creation commission is paid once per promissory note, whichever path deploys.
  IF p_kind = 'portfolio_creation' AND EXISTS (
    SELECT 1 FROM public.promissory_commission_events e
     WHERE e.note_id = v_note_id AND e.kind = 'portfolio_creation' AND e.status = 'paid'
  ) THEN
    RETURN jsonb_build_object('status','skipped','reason','creation_commission_already_paid');
  END IF;

  v_idem := 'promissory_commission:' || p_kind || ':' || p_source_table || ':' || p_source_id;

  IF EXISTS (SELECT 1 FROM public.promissory_commission_events e
              WHERE e.idempotency_key = v_idem AND e.status = 'paid') THEN
    RETURN jsonb_build_object('status','skipped','reason','duplicate_source');
  END IF;

  v_label := CASE WHEN p_kind = 'portfolio_creation'
                  THEN 'Promissory partner portfolio commission ('
                  ELSE 'Promissory partner top-up commission (' END
             || to_char(v_rate * 100, 'FM999.99') || '%)';

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object('user_id', v_agent_id, 'amount', v_amount,
        'direction','cash_out', 'category','marketing_expense',
        'source_table', p_source_table, 'source_id', p_source_id,
        'description', 'Marketing expense: ' || v_label,
        'ledger_scope','platform'),
      jsonb_build_object('user_id', v_agent_id, 'amount', v_amount,
        'direction','cash_in', 'category','agent_commission',
        'source_table', p_source_table, 'source_id', p_source_id,
        'description', v_label,
        'ledger_scope','wallet', 'recipient_type','user')),
    v_idem);

  INSERT INTO public.promissory_commission_events
    (note_id, agent_id, partner_id, kind, base_amount, rate, amount,
     source_table, source_id, idempotency_key, ledger_group_id, status)
  VALUES (v_note_id, v_agent_id, p_partner_id, p_kind, p_base_amount, v_rate, v_amount,
          p_source_table, p_source_id, v_idem, v_group, 'paid')
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('status','paid','amount',v_amount,'rate',v_rate,
                            'agent_id',v_agent_id,'note_id',v_note_id,'ledger_group_id',v_group);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_promissory_agent_commission(uuid, numeric, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credit_promissory_agent_commission(uuid, numeric, text, text, text) TO service_role;

-- Failure-tolerant wrapper: money flows must never be blocked by a commission hiccup.
CREATE OR REPLACE FUNCTION public.try_credit_promissory_agent_commission(
  p_partner_id uuid, p_base_amount numeric, p_kind text, p_source_table text, p_source_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
BEGIN
  PERFORM public.credit_promissory_agent_commission(
    p_partner_id, p_base_amount, p_kind, p_source_table, p_source_id);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.promissory_commission_events
    (partner_id, kind, base_amount, source_table, source_id,
     idempotency_key, status, error_message)
  VALUES (p_partner_id, p_kind, coalesce(p_base_amount,0), p_source_table, p_source_id,
          'promissory_commission:' || p_kind || ':' || p_source_table || ':' || p_source_id
            || ':failed:' || gen_random_uuid()::text,
          'failed', sqlerrm);
END;
$$;

REVOKE ALL ON FUNCTION public.try_credit_promissory_agent_commission(uuid, numeric, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_credit_promissory_agent_commission(uuid, numeric, text, text, text) TO service_role;

-- ── Path 1: investor_portfolios (covers every creation / top-up edge function) ─
CREATE OR REPLACE FUNCTION public.trg_promissory_commission_portfolio()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
DECLARE v_delta numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'active' AND coalesce(NEW.investment_amount,0) > 0 THEN
      PERFORM public.try_credit_promissory_agent_commission(
        NEW.investor_id, NEW.investment_amount, 'portfolio_creation',
        'investor_portfolios', NEW.id::text);
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.status = 'active' AND coalesce(OLD.status,'') <> 'active'
     AND coalesce(NEW.investment_amount,0) > 0 THEN
    PERFORM public.try_credit_promissory_agent_commission(
      NEW.investor_id, NEW.investment_amount, 'portfolio_creation',
      'investor_portfolios', NEW.id::text);
    RETURN NULL;
  END IF;

  v_delta := coalesce(NEW.investment_amount,0) - coalesce(OLD.investment_amount,0);
  IF v_delta > 0 AND NEW.status = 'active' THEN
    PERFORM public.try_credit_promissory_agent_commission(
      NEW.investor_id, v_delta, 'portfolio_topup',
      'investor_portfolios', NEW.id::text || ':' || round(coalesce(NEW.investment_amount,0))::text);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_promissory_commission_portfolio ON public.investor_portfolios;
CREATE TRIGGER trg_promissory_commission_portfolio
  AFTER INSERT OR UPDATE OF status, investment_amount ON public.investor_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.trg_promissory_commission_portfolio();

-- ── Path 2: self-support commitments (the promissory-linked default) ─────────
CREATE OR REPLACE FUNCTION public.trg_promissory_commission_self_commitment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
BEGIN
  IF NEW.status = 'active'
     AND (TG_OP = 'INSERT' OR coalesce(OLD.status,'') <> 'active')
     AND coalesce(NEW.committed_amount,0) > 0 THEN
    PERFORM public.try_credit_promissory_agent_commission(
      NEW.partner_id, NEW.committed_amount, 'portfolio_creation',
      'partner_self_commitments', NEW.id::text);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_promissory_commission_self_commitment ON public.partner_self_commitments;
CREATE TRIGGER trg_promissory_commission_self_commitment
  AFTER INSERT OR UPDATE OF status ON public.partner_self_commitments
  FOR EACH ROW EXECUTE FUNCTION public.trg_promissory_commission_self_commitment();

-- ── Path 3: self-support top-ups ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_promissory_commission_self_topup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $$
BEGIN
  IF NEW.status IN ('approved','active','applied')
     AND (TG_OP = 'INSERT' OR coalesce(OLD.status,'') IS DISTINCT FROM NEW.status)
     AND coalesce(NEW.amount,0) > 0 THEN
    PERFORM public.try_credit_promissory_agent_commission(
      NEW.partner_id, NEW.amount, 'portfolio_topup',
      'partner_self_topups', NEW.id::text);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_promissory_commission_self_topup ON public.partner_self_topups;
CREATE TRIGGER trg_promissory_commission_self_topup
  AFTER INSERT OR UPDATE OF status ON public.partner_self_topups
  FOR EACH ROW EXECUTE FUNCTION public.trg_promissory_commission_self_topup();

-- ── CFO / Partner Ops reporting view ────────────────────────────────────────
DROP VIEW IF EXISTS public.v_promissory_agent_commissions;
CREATE VIEW public.v_promissory_agent_commissions
WITH (security_invoker = on) AS
SELECT e.id,
       e.created_at,
       e.kind,
       e.status,
       e.skip_reason,
       e.error_message,
       e.base_amount,
       e.rate,
       e.amount,
       e.source_table,
       e.source_id,
       e.ledger_group_id,
       e.note_id,
       n.partner_name AS note_partner_name,
       n.amount AS note_amount,
       e.agent_id,
       ap.full_name AS agent_name,
       ap.phone AS agent_phone,
       e.partner_id,
       pp.full_name AS partner_name,
       pp.phone AS partner_phone
  FROM public.promissory_commission_events e
  LEFT JOIN public.promissory_notes n ON n.id = e.note_id
  LEFT JOIN public.profiles ap ON ap.id = e.agent_id
  LEFT JOIN public.profiles pp ON pp.id = e.partner_id;

GRANT SELECT ON public.v_promissory_agent_commissions TO authenticated;