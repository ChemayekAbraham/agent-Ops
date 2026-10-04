-- ── PHASE 6 — funding-source truth for merchant payouts ──────────────────

CREATE TABLE IF NOT EXISTS public.merchant_payout_funding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL UNIQUE REFERENCES public.withdrawal_requests(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  payout_amount numeric NOT NULL DEFAULT 0,
  telecom_charge_expected numeric NOT NULL DEFAULT 0,
  float_consumed_principal numeric NOT NULL DEFAULT 0,
  float_consumed_telecom numeric NOT NULL DEFAULT 0,
  own_cash_principal numeric NOT NULL DEFAULT 0,
  own_cash_telecom numeric NOT NULL DEFAULT 0,
  receivable_recorded numeric NOT NULL DEFAULT 0,
  funding_source text NOT NULL DEFAULT 'unknown'
    CHECK (funding_source IN ('float','own_cash','mixed','none','unknown')),
  classified_at timestamptz NOT NULL DEFAULT now(),
  classified_via text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.merchant_payout_funding TO authenticated;
GRANT ALL ON public.merchant_payout_funding TO service_role;

ALTER TABLE public.merchant_payout_funding ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Merchant sees own payout funding"
ON public.merchant_payout_funding FOR SELECT TO authenticated
USING (agent_id = auth.uid());

CREATE POLICY "Finance and exec see all payout funding"
ON public.merchant_payout_funding FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'financial_ops') OR public.has_role(auth.uid(), 'super_admin')
);

CREATE INDEX IF NOT EXISTS idx_merchant_payout_funding_agent
  ON public.merchant_payout_funding(agent_id, classified_at DESC);
CREATE INDEX IF NOT EXISTS idx_merchant_payout_funding_source
  ON public.merchant_payout_funding(funding_source);

CREATE TRIGGER trg_merchant_payout_funding_updated_at
BEFORE UPDATE ON public.merchant_payout_funding
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Telecom sending-charge tiers (mirrors src/lib/cashoutCharges.ts)
CREATE OR REPLACE FUNCTION public.telecom_sending_charge(p_amount numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN COALESCE(p_amount,0) <= 0 THEN 0
    WHEN p_amount <= 5000 THEN 100
    WHEN p_amount <= 60000 THEN 500
    WHEN p_amount <= 500000 THEN 1000
    WHEN p_amount <= 1000000 THEN 1500
    ELSE 2000
  END::numeric
$$;

-- Authoritative classifier: reads only REAL ledger movements, never intent.
CREATE OR REPLACE FUNCTION public.classify_merchant_payout_funding(
  p_withdrawal_id uuid,
  p_via text DEFAULT 'manual'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w record;
  v_agent uuid;
  v_amount numeric := 0;
  v_telecom numeric := 0;
  v_float_principal numeric := 0;
  v_float_telecom numeric := 0;
  v_own_principal numeric := 0;
  v_own_telecom numeric := 0;
  v_source text;
  v_receivable numeric := 0;
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF w.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'withdrawal_not_found');
  END IF;

  -- Merchant identity: reservation row first, then the claiming/processing
  -- staff member validated against an ACTIVE cash-out desk.
  SELECT r.agent_id INTO v_agent
  FROM public.merchant_float_reservations r
  WHERE r.withdrawal_id = p_withdrawal_id
  LIMIT 1;

  IF v_agent IS NULL THEN
    SELECT ca.user_id INTO v_agent
    FROM public.cashout_agents ca
    WHERE ca.is_active = true
      AND ca.user_id IN (w.dispatch_claimed_by, w.processed_by, w.processing_started_by)
    LIMIT 1;
  END IF;

  IF v_agent IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'not_a_merchant_payout');
  END IF;

  v_amount := GREATEST(0, COALESCE(w.amount, 0));
  v_telecom := public.telecom_sending_charge(v_amount);

  -- Actual float movements, keyed by their distinct reference ids.
  SELECT COALESCE(SUM(gl.amount), 0) INTO v_float_principal
  FROM public.general_ledger gl
  WHERE gl.reference_id = p_withdrawal_id::text || '-merchant-float-consume'
    AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_out';

  SELECT COALESCE(SUM(gl.amount), 0) INTO v_float_telecom
  FROM public.general_ledger gl
  WHERE gl.reference_id = p_withdrawal_id::text || '-merchant-telecom-charge'
    AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_out';

  -- Float can never exceed what it was supposed to cover.
  v_float_principal := LEAST(v_float_principal, v_amount);
  v_float_telecom := LEAST(v_float_telecom, v_telecom);

  v_own_principal := GREATEST(0, v_amount - v_float_principal);
  v_own_telecom := GREATEST(0, v_telecom - v_float_telecom);

  v_source := CASE
    WHEN v_amount = 0 THEN 'none'
    WHEN v_float_principal + v_float_telecom = 0 THEN 'own_cash'
    WHEN v_own_principal + v_own_telecom = 0 THEN 'float'
    ELSE 'mixed'
  END;

  -- Repair the receivable rows so they match the books exactly. A float leg
  -- that never posted must show up as merchant own-cash, not vanish.
  IF v_own_principal > 0 THEN
    INSERT INTO public.merchant_out_of_pocket_advances
      (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
       shortfall_amount, status, note)
    VALUES (v_agent, p_withdrawal_id, 'payout', v_amount, v_telecom,
            v_float_principal, ROUND(v_own_principal), 'pending_reimbursement',
            'Phase 6 classification: merchant fronted UGX ' ||
            ROUND(v_own_principal)::text || ' of the payout principal.')
    ON CONFLICT (withdrawal_id, kind) DO UPDATE
      SET float_used = EXCLUDED.float_used,
          telecom_charge = EXCLUDED.telecom_charge,
          payout_amount = EXCLUDED.payout_amount,
          shortfall_amount = EXCLUDED.shortfall_amount,
          updated_at = now()
      WHERE public.merchant_out_of_pocket_advances.status = 'pending_reimbursement';
  ELSE
    DELETE FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id AND kind = 'payout'
      AND status = 'pending_reimbursement';
  END IF;

  IF v_own_telecom > 0 THEN
    INSERT INTO public.merchant_out_of_pocket_advances
      (agent_id, withdrawal_id, kind, payout_amount, telecom_charge, float_used,
       shortfall_amount, status, note)
    VALUES (v_agent, p_withdrawal_id, 'telecom', v_amount, v_telecom,
            v_float_telecom, ROUND(v_own_telecom), 'pending_reimbursement',
            'Phase 6 classification: merchant paid UGX ' ||
            ROUND(v_own_telecom)::text || ' of the telecom sending charge.')
    ON CONFLICT (withdrawal_id, kind) DO UPDATE
      SET float_used = EXCLUDED.float_used,
          telecom_charge = EXCLUDED.telecom_charge,
          payout_amount = EXCLUDED.payout_amount,
          shortfall_amount = EXCLUDED.shortfall_amount,
          updated_at = now()
      WHERE public.merchant_out_of_pocket_advances.status = 'pending_reimbursement';
  ELSE
    DELETE FROM public.merchant_out_of_pocket_advances
    WHERE withdrawal_id = p_withdrawal_id AND kind = 'telecom'
      AND status = 'pending_reimbursement';
  END IF;

  SELECT COALESCE(SUM(shortfall_amount), 0) INTO v_receivable
  FROM public.merchant_out_of_pocket_advances
  WHERE withdrawal_id = p_withdrawal_id;

  INSERT INTO public.merchant_payout_funding
    (withdrawal_id, agent_id, payout_amount, telecom_charge_expected,
     float_consumed_principal, float_consumed_telecom, own_cash_principal,
     own_cash_telecom, receivable_recorded, funding_source, classified_via)
  VALUES (p_withdrawal_id, v_agent, v_amount, v_telecom, v_float_principal,
          v_float_telecom, ROUND(v_own_principal), ROUND(v_own_telecom),
          v_receivable, v_source, p_via)
  ON CONFLICT (withdrawal_id) DO UPDATE
    SET agent_id = EXCLUDED.agent_id,
        payout_amount = EXCLUDED.payout_amount,
        telecom_charge_expected = EXCLUDED.telecom_charge_expected,
        float_consumed_principal = EXCLUDED.float_consumed_principal,
        float_consumed_telecom = EXCLUDED.float_consumed_telecom,
        own_cash_principal = EXCLUDED.own_cash_principal,
        own_cash_telecom = EXCLUDED.own_cash_telecom,
        receivable_recorded = EXCLUDED.receivable_recorded,
        funding_source = EXCLUDED.funding_source,
        classified_via = EXCLUDED.classified_via,
        classified_at = now(),
        updated_at = now();

  -- Keep the reservation ledger honest about what was really consumed.
  UPDATE public.merchant_float_reservations
     SET consumed_float = v_float_principal,
         consumed_telecom = v_float_telecom,
         out_of_pocket_amount = ROUND(v_own_principal + v_own_telecom),
         updated_at = now()
   WHERE withdrawal_id = p_withdrawal_id;

  RETURN jsonb_build_object(
    'ok', true,
    'withdrawal_id', p_withdrawal_id,
    'agent_id', v_agent,
    'funding_source', v_source,
    'payout_amount', v_amount,
    'telecom_charge_expected', v_telecom,
    'float_consumed_principal', v_float_principal,
    'float_consumed_telecom', v_float_telecom,
    'own_cash_principal', ROUND(v_own_principal),
    'own_cash_telecom', ROUND(v_own_telecom),
    'receivable_recorded', v_receivable
  );
END;
$$;

REVOKE ALL ON FUNCTION public.classify_merchant_payout_funding(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.classify_merchant_payout_funding(uuid, text) TO service_role;

-- Monitoring view: funding record vs the books.
CREATE OR REPLACE VIEW public.v_merchant_payout_funding_mismatch AS
SELECT
  f.withdrawal_id,
  f.agent_id,
  f.payout_amount,
  f.funding_source,
  f.float_consumed_principal,
  f.own_cash_principal,
  f.receivable_recorded,
  f.classified_at,
  (SELECT COALESCE(SUM(gl.amount),0) FROM public.general_ledger gl
     WHERE gl.reference_id = f.withdrawal_id::text || '-merchant-float-consume'
       AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_out') AS ledger_float_principal,
  (SELECT COALESCE(SUM(o.shortfall_amount),0) FROM public.merchant_out_of_pocket_advances o
     WHERE o.withdrawal_id = f.withdrawal_id) AS receivable_now
FROM public.merchant_payout_funding f
WHERE f.float_consumed_principal <> (
        SELECT COALESCE(SUM(gl.amount),0) FROM public.general_ledger gl
        WHERE gl.reference_id = f.withdrawal_id::text || '-merchant-float-consume'
          AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_out')
   OR f.receivable_recorded <> (
        SELECT COALESCE(SUM(o.shortfall_amount),0) FROM public.merchant_out_of_pocket_advances o
        WHERE o.withdrawal_id = f.withdrawal_id);

GRANT SELECT ON public.v_merchant_payout_funding_mismatch TO authenticated, service_role;

-- Reconciler: re-classify recently touched merchant payouts.
CREATE OR REPLACE FUNCTION public.reconcile_merchant_payout_funding(
  p_lookback_hours integer DEFAULT 72,
  p_limit integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_done integer := 0;
  v_changed integer := 0;
  v_res jsonb;
BEGIN
  FOR r IN
    SELECT w.id
    FROM public.withdrawal_requests w
    WHERE w.status IN ('paid','completed','approved','processing')
      AND COALESCE(w.processed_at, w.updated_at, w.created_at)
          > now() - make_interval(hours => GREATEST(1, p_lookback_hours))
      AND (
        EXISTS (SELECT 1 FROM public.merchant_float_reservations mr WHERE mr.withdrawal_id = w.id)
        OR EXISTS (SELECT 1 FROM public.cashout_agents ca
                   WHERE ca.is_active = true
                     AND ca.user_id IN (w.dispatch_claimed_by, w.processed_by, w.processing_started_by))
      )
    ORDER BY COALESCE(w.processed_at, w.updated_at, w.created_at) DESC
    LIMIT GREATEST(1, p_limit)
  LOOP
    BEGIN
      v_res := public.classify_merchant_payout_funding(r.id, 'reconciler');
      v_done := v_done + 1;
      IF COALESCE((v_res->>'own_cash_principal')::numeric, 0) > 0 THEN
        v_changed := v_changed + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'classified', v_done, 'own_cash_involved', v_changed);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_merchant_payout_funding(integer, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.reconcile_merchant_payout_funding(integer, integer) TO service_role;

SELECT cron.unschedule('reconcile-merchant-payout-funding')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconcile-merchant-payout-funding');

SELECT cron.schedule(
  'reconcile-merchant-payout-funding',
  '*/10 * * * *',
  $cron$ SELECT public.reconcile_merchant_payout_funding(72, 300); $cron$
);
