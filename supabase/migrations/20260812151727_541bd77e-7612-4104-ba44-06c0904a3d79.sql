-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 5 — AUTHORITATIVE MERCHANT PAYOUT COMMISSION
-- Commission must be derived from the settlement event (customer debited +
-- payout terminal), NOT from whether a fragile side effect (`floatLegSettled`)
-- happened to be true inside the edge function.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.merchant_commission_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL UNIQUE REFERENCES public.withdrawal_requests(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  desk_id uuid,
  payout_amount numeric NOT NULL,
  commission_rate numeric NOT NULL DEFAULT 0.005,
  commission_amount numeric NOT NULL,
  reference_id text NOT NULL,
  awarded_via text NOT NULL DEFAULT 'settlement_event',
  awarded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.merchant_commission_awards TO authenticated;
GRANT ALL ON public.merchant_commission_awards TO service_role;
ALTER TABLE public.merchant_commission_awards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own commission awards"
  ON public.merchant_commission_awards FOR SELECT TO authenticated
  USING (
    agent_id = (SELECT auth.uid())
    OR public.has_role((SELECT auth.uid()), 'cfo')
    OR public.has_role((SELECT auth.uid()), 'financial_ops')
    OR public.has_role((SELECT auth.uid()), 'super_admin')
  );

CREATE INDEX IF NOT EXISTS idx_mca_agent ON public.merchant_commission_awards(agent_id, awarded_at DESC);

DROP TRIGGER IF EXISTS trg_mca_updated_at ON public.merchant_commission_awards;
CREATE TRIGGER trg_mca_updated_at BEFORE UPDATE ON public.merchant_commission_awards
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Server-side merchant identity for a payout ───────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_payout_commission_agent(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w record;
  v_agent uuid;
  v_desk uuid;
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF w IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'withdrawal_not_found');
  END IF;

  -- 1) The desk that was assigned owns the payout.
  SELECT ca.agent_id, ca.id INTO v_agent, v_desk
  FROM public.cashout_agents ca
  WHERE ca.id = w.assigned_cashout_agent_id
  LIMIT 1;

  -- 2) Fall back to the user who actually claimed/processed it, but only when
  --    they really are a merchant agent (an active cash-out desk).
  IF v_agent IS NULL THEN
    SELECT ca.agent_id, ca.id INTO v_agent, v_desk
    FROM public.cashout_agents ca
    WHERE ca.agent_id IN (w.processing_started_by, w.dispatch_claimed_by)
      AND ca.is_active IS TRUE
    ORDER BY (ca.agent_id = w.processing_started_by) DESC
    LIMIT 1;
  END IF;

  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_merchant_agent');
  END IF;

  RETURN jsonb_build_object('ok', true, 'agent_id', v_agent, 'desk_id', v_desk);
END;
$$;

-- ── Eligibility: derived from the settlement event only ──────────────────────
CREATE OR REPLACE FUNCTION public.merchant_commission_eligibility(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w record;
  v_ident jsonb;
  v_debited boolean;
  v_paid boolean;
  v_existing numeric;
  v_amount numeric;
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF w IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'withdrawal_not_found');
  END IF;

  v_ident := public.resolve_payout_commission_agent(p_withdrawal_id);
  IF NOT coalesce((v_ident->>'ok')::boolean, false) THEN
    RETURN jsonb_build_object('eligible', false, 'reason', v_ident->>'error');
  END IF;

  -- The payout must be terminal-good. Failed / rejected / reversed never earn.
  v_paid := w.status IN ('paid', 'completed', 'disbursed');
  IF NOT v_paid THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'payout_not_paid',
                              'status', w.status, 'agent_id', v_ident->>'agent_id');
  END IF;

  -- The customer's wallet MUST actually have been debited: that is the
  -- authoritative settlement event for an eligible completed payout.
  SELECT EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.source_table = 'withdrawal_requests'
      AND g.source_id = p_withdrawal_id
      AND g.ledger_scope = 'wallet'
      AND g.user_id = w.user_id
      AND g.direction = 'cash_out'
  ) INTO v_debited;

  IF NOT v_debited THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'customer_wallet_not_debited',
                              'agent_id', v_ident->>'agent_id');
  END IF;

  v_amount := round(coalesce(w.amount, 0) * 0.005);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'commission_rounds_to_zero',
                              'agent_id', v_ident->>'agent_id');
  END IF;

  SELECT coalesce(sum(g.amount), 0) INTO v_existing
  FROM public.general_ledger g
  WHERE g.reference_id = p_withdrawal_id::text || '-cashout-commission'
    AND g.ledger_scope = 'wallet';

  RETURN jsonb_build_object(
    'eligible', v_existing <= 0,
    'reason', CASE WHEN v_existing > 0 THEN 'already_paid' ELSE 'eligible' END,
    'agent_id', v_ident->>'agent_id',
    'desk_id', v_ident->>'desk_id',
    'payout_amount', w.amount,
    'commission_amount', v_amount,
    'already_paid_amount', v_existing
  );
END;
$$;

-- ── The single commission writer (idempotent, exactly-once) ──────────────────
CREATE OR REPLACE FUNCTION public.credit_merchant_payout_commission(
  p_withdrawal_id uuid,
  p_awarded_via text DEFAULT 'settlement_event'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_elig jsonb;
  v_agent uuid;
  v_desk uuid;
  v_amount numeric;
  v_payout numeric;
  v_ref text := p_withdrawal_id::text || '-cashout-commission';
  v_now timestamptz := now();
  v_entries jsonb;
BEGIN
  v_elig := public.merchant_commission_eligibility(p_withdrawal_id);

  IF NOT coalesce((v_elig->>'eligible')::boolean, false) THEN
    RETURN jsonb_build_object('ok', true, 'credited', false,
                              'reason', v_elig->>'reason', 'detail', v_elig);
  END IF;

  v_agent  := (v_elig->>'agent_id')::uuid;
  v_desk   := nullif(v_elig->>'desk_id', '')::uuid;
  v_amount := (v_elig->>'commission_amount')::numeric;
  v_payout := (v_elig->>'payout_amount')::numeric;

  -- Row-level guard: only one writer may award a given payout.
  BEGIN
    INSERT INTO public.merchant_commission_awards (
      withdrawal_id, agent_id, desk_id, payout_amount,
      commission_rate, commission_amount, reference_id, awarded_via
    ) VALUES (
      p_withdrawal_id, v_agent, v_desk, v_payout,
      0.005, v_amount, v_ref, coalesce(p_awarded_via, 'settlement_event')
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', true, 'credited', false, 'reason', 'award_already_recorded');
  END;

  v_entries := jsonb_build_array(
    jsonb_build_object(
      'user_id', v_agent, 'ledger_scope', 'platform', 'direction', 'cash_out',
      'amount', v_amount, 'category', 'agent_commission_earned',
      'source_table', 'withdrawal_requests', 'source_id', p_withdrawal_id,
      'description', 'Cashout payout commission expense (0.5%) for withdrawal ' || p_withdrawal_id::text,
      'currency', 'UGX', 'reference_id', v_ref, 'transaction_date', v_now
    ),
    jsonb_build_object(
      'user_id', v_agent, 'ledger_scope', 'wallet', 'direction', 'cash_in',
      'amount', v_amount, 'category', 'agent_commission_earned',
      'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'withdrawal_requests', 'source_id', p_withdrawal_id,
      'description', 'Cashout payout commission (0.5%) for withdrawal ' || p_withdrawal_id::text,
      'currency', 'UGX', 'reference_id', v_ref, 'transaction_date', v_now
    )
  );

  PERFORM public.create_ledger_transaction(
    v_entries,
    'approve-withdrawal-cashout-commission-' || p_withdrawal_id::text,
    false
  );

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('agent_collection', v_agent, 'withdrawal_requests', p_withdrawal_id,
          jsonb_build_object('kind', 'merchant_payout_commission',
                             'commission_amount', v_amount,
                             'payout_amount', v_payout,
                             'awarded_via', coalesce(p_awarded_via, 'settlement_event')));

  RETURN jsonb_build_object('ok', true, 'credited', true, 'agent_id', v_agent,
                            'commission_amount', v_amount, 'payout_amount', v_payout,
                            'reference_id', v_ref);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_merchant_payout_commission(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_merchant_payout_commission(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.merchant_commission_eligibility(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_payout_commission_agent(uuid) TO authenticated, service_role;

-- ── Self-healing sweep: commission can never be lost by a transient failure ──
CREATE OR REPLACE FUNCTION public.reconcile_merchant_payout_commissions(
  p_limit integer DEFAULT 250,
  p_since timestamptz DEFAULT '2026-07-16 00:00:00+00'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_res jsonb;
  v_paid integer := 0;
  v_total numeric := 0;
  v_skipped integer := 0;
BEGIN
  FOR r IN
    SELECT w.id
    FROM public.withdrawal_requests w
    WHERE w.status IN ('paid', 'completed', 'disbursed')
      AND coalesce(w.processed_at, w.updated_at, w.created_at) >= p_since
      AND NOT EXISTS (
        SELECT 1 FROM public.merchant_commission_awards a WHERE a.withdrawal_id = w.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.general_ledger g
        WHERE g.reference_id = w.id::text || '-cashout-commission'
      )
    ORDER BY coalesce(w.processed_at, w.created_at) DESC
    LIMIT greatest(1, least(coalesce(p_limit, 250), 1000))
  LOOP
    BEGIN
      v_res := public.credit_merchant_payout_commission(r.id, 'reconciler');
      IF coalesce((v_res->>'credited')::boolean, false) THEN
        v_paid := v_paid + 1;
        v_total := v_total + coalesce((v_res->>'commission_amount')::numeric, 0);
      ELSE
        v_skipped := v_skipped + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'credited_count', v_paid,
                            'credited_amount', v_total, 'skipped', v_skipped, 'since', p_since);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_merchant_payout_commissions(integer, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_merchant_payout_commissions(integer, timestamptz) TO service_role;

-- ── Finance review surface ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_merchant_commission_outstanding
WITH (security_invoker = true) AS
SELECT
  w.id AS withdrawal_id,
  w.amount AS payout_amount,
  round(w.amount * 0.005) AS commission_due,
  w.status,
  w.settlement_state,
  coalesce(w.processed_at, w.created_at) AS payout_at,
  (public.merchant_commission_eligibility(w.id) ->> 'agent_id')::uuid AS agent_id,
  p.full_name AS agent_name,
  public.merchant_commission_eligibility(w.id) ->> 'reason' AS blocker
FROM public.withdrawal_requests w
LEFT JOIN public.cashout_agents ca ON ca.id = w.assigned_cashout_agent_id
LEFT JOIN public.profiles p ON p.id = ca.agent_id
WHERE w.status IN ('paid', 'completed', 'disbursed')
  AND NOT EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.reference_id = w.id::text || '-cashout-commission'
  );

GRANT SELECT ON public.v_merchant_commission_outstanding TO authenticated, service_role;

-- ── Cron: sweep every 15 minutes ────────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('reconcile-merchant-payout-commissions');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'reconcile-merchant-payout-commissions',
  '*/15 * * * *',
  $$SELECT public.reconcile_merchant_payout_commissions(250);$$
);