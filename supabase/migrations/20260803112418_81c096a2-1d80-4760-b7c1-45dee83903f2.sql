-- =====================================================================
-- Self Portfolio Management (Partner Self-Managed Funding) — PHASE ONE
-- Backend only. Does NOT touch the managed portfolio path
-- (investor_portfolios / process-supporter-roi / rent_requests.supporter_id).
-- =====================================================================

-- ---------------------------------------------------------------
-- 0. Linkage columns on rent_requests (supporter_id deliberately untouched
--    so the existing managed ROI engine never sees self-managed plans)
-- ---------------------------------------------------------------
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS self_funding_partner_id uuid,
  ADD COLUMN IF NOT EXISTS self_funding_line_id uuid;

CREATE INDEX IF NOT EXISTS idx_rent_requests_self_funding_partner
  ON public.rent_requests (self_funding_partner_id)
  WHERE self_funding_partner_id IS NOT NULL;

-- ---------------------------------------------------------------
-- 1. Commitments (partner-level term + payout clock)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_self_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  committed_amount numeric NOT NULL CHECK (committed_amount > 0),
  term_months integer NOT NULL DEFAULT 12 CHECK (term_months BETWEEN 1 AND 60),
  monthly_rate numeric NOT NULL DEFAULT 15 CHECK (monthly_rate >= 0 AND monthly_rate <= 100),
  lines_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','matured','cancelled')),
  payout_anchor_at timestamptz,
  payout_day smallint,
  next_payout_at timestamptz,
  term_end_at timestamptz,
  total_earned numeric NOT NULL DEFAULT 0,
  total_paid numeric NOT NULL DEFAULT 0,
  idempotency_key text,
  ledger_group_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_psc_idempotency
  ON public.partner_self_commitments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_psc_partner_status
  ON public.partner_self_commitments (partner_id, status);
CREATE INDEX IF NOT EXISTS idx_psc_next_payout
  ON public.partner_self_commitments (next_payout_at)
  WHERE status = 'active';

GRANT SELECT ON public.partner_self_commitments TO authenticated;
GRANT ALL ON public.partner_self_commitments TO service_role;
ALTER TABLE public.partner_self_commitments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "psm commitments readable by owner"
  ON public.partner_self_commitments FOR SELECT TO authenticated
  USING (partner_id = auth.uid());
CREATE POLICY "psm commitments readable by ops"
  ON public.partner_self_commitments FOR SELECT TO authenticated
  USING (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'ceo') OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin')
  );

-- ---------------------------------------------------------------
-- 2. Funding lines (one per tenant plan — the unit of money)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_self_funding_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id uuid NOT NULL REFERENCES public.partner_self_commitments(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL,
  rent_request_id uuid NOT NULL,
  principal numeric NOT NULL CHECK (principal > 0),
  monthly_rate numeric NOT NULL DEFAULT 15,
  term_months integer NOT NULL DEFAULT 12,
  status text NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle','earning','completed','cancelled')),
  committed_at timestamptz NOT NULL DEFAULT now(),
  live_at timestamptz,
  term_end_at timestamptz,
  completed_at timestamptz,
  total_earned numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- FIFO integrity: a plan may carry only one live self-managed line
CREATE UNIQUE INDEX IF NOT EXISTS ux_psfl_active_plan
  ON public.partner_self_funding_lines (rent_request_id)
  WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS idx_psfl_commitment ON public.partner_self_funding_lines (commitment_id);
CREATE INDEX IF NOT EXISTS idx_psfl_partner_status ON public.partner_self_funding_lines (partner_id, status);

GRANT SELECT ON public.partner_self_funding_lines TO authenticated;
GRANT ALL ON public.partner_self_funding_lines TO service_role;
ALTER TABLE public.partner_self_funding_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "psm lines readable by owner"
  ON public.partner_self_funding_lines FOR SELECT TO authenticated
  USING (partner_id = auth.uid());
CREATE POLICY "psm lines readable by ops"
  ON public.partner_self_funding_lines FOR SELECT TO authenticated
  USING (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'ceo') OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin')
  );

-- ---------------------------------------------------------------
-- 3. Exclusive plan holds (FIFO, first writer wins)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_self_plan_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'held'
    CHECK (status IN ('held','confirmed','released','expired')),
  idempotency_key text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  confirmed_at timestamptz,
  closed_at timestamptz,
  commitment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One active hold per plan, ever. This IS the FIFO guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pspc_active_plan
  ON public.partner_self_plan_claims (rent_request_id)
  WHERE status IN ('held','confirmed');
CREATE UNIQUE INDEX IF NOT EXISTS ux_pspc_idempotency
  ON public.partner_self_plan_claims (partner_id, rent_request_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pspc_partner_status
  ON public.partner_self_plan_claims (partner_id, status);
CREATE INDEX IF NOT EXISTS idx_pspc_expiry
  ON public.partner_self_plan_claims (expires_at) WHERE status = 'held';

GRANT SELECT ON public.partner_self_plan_claims TO authenticated;
GRANT ALL ON public.partner_self_plan_claims TO service_role;
ALTER TABLE public.partner_self_plan_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "psm claims readable by owner"
  ON public.partner_self_plan_claims FOR SELECT TO authenticated
  USING (partner_id = auth.uid());
CREATE POLICY "psm claims readable by ops"
  ON public.partner_self_plan_claims FOR SELECT TO authenticated
  USING (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'ceo') OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin')
  );

-- ---------------------------------------------------------------
-- 4. Recognised earnings (per line, per cycle) — recognition before payment
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_self_earnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id uuid NOT NULL REFERENCES public.partner_self_funding_lines(id) ON DELETE CASCADE,
  commitment_id uuid NOT NULL REFERENCES public.partner_self_commitments(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL,
  cycle_start date NOT NULL,
  cycle_end date NOT NULL,
  days_live integer NOT NULL,
  days_in_cycle integer NOT NULL,
  principal numeric NOT NULL,
  monthly_rate numeric NOT NULL,
  amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued','paid','void')),
  payout_cycle_id uuid,
  recognized_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pse_line_cycle
  ON public.partner_self_earnings (line_id, cycle_end);
CREATE INDEX IF NOT EXISTS idx_pse_partner_status
  ON public.partner_self_earnings (partner_id, status);
CREATE INDEX IF NOT EXISTS idx_pse_payout_cycle ON public.partner_self_earnings (payout_cycle_id);

GRANT SELECT ON public.partner_self_earnings TO authenticated;
GRANT ALL ON public.partner_self_earnings TO service_role;
ALTER TABLE public.partner_self_earnings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "psm earnings readable by owner"
  ON public.partner_self_earnings FOR SELECT TO authenticated
  USING (partner_id = auth.uid());
CREATE POLICY "psm earnings readable by ops"
  ON public.partner_self_earnings FOR SELECT TO authenticated
  USING (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'ceo') OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin')
  );

-- ---------------------------------------------------------------
-- 5. Partner-level monthly payout cycles (one payment, one date)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_self_payout_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  commitment_id uuid NOT NULL REFERENCES public.partner_self_commitments(id) ON DELETE CASCADE,
  cycle_start date NOT NULL,
  cycle_end date NOT NULL,
  lines_count integer NOT NULL DEFAULT 0,
  total_amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','void')),
  ledger_group_id uuid,
  failure_reason text,
  recognized_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pspay_commitment_cycle
  ON public.partner_self_payout_cycles (commitment_id, cycle_end);
CREATE INDEX IF NOT EXISTS idx_pspay_status ON public.partner_self_payout_cycles (status, cycle_end);
CREATE INDEX IF NOT EXISTS idx_pspay_partner ON public.partner_self_payout_cycles (partner_id);

GRANT SELECT ON public.partner_self_payout_cycles TO authenticated;
GRANT ALL ON public.partner_self_payout_cycles TO service_role;
ALTER TABLE public.partner_self_payout_cycles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "psm payouts readable by owner"
  ON public.partner_self_payout_cycles FOR SELECT TO authenticated
  USING (partner_id = auth.uid());
CREATE POLICY "psm payouts readable by ops"
  ON public.partner_self_payout_cycles FOR SELECT TO authenticated
  USING (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'ceo') OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin')
  );

-- ---------------------------------------------------------------
-- 6. Audit trail (fire and forget, never blocks a money path)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_self_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  partner_id uuid,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_psa_partner_time ON public.partner_self_audit (partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_psa_entity ON public.partner_self_audit (entity_type, entity_id);

GRANT SELECT ON public.partner_self_audit TO authenticated;
GRANT ALL ON public.partner_self_audit TO service_role;
ALTER TABLE public.partner_self_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "psm audit readable by owner"
  ON public.partner_self_audit FOR SELECT TO authenticated
  USING (partner_id = auth.uid());
CREATE POLICY "psm audit readable by ops"
  ON public.partner_self_audit FOR SELECT TO authenticated
  USING (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'ceo') OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin')
  );

-- ---------------------------------------------------------------
-- 7. Shared helpers (DRY)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.psm_audit(
  p_actor uuid, p_partner uuid, p_action text,
  p_entity_type text DEFAULT NULL, p_entity_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.partner_self_audit(actor_id, partner_id, action, entity_type, entity_id, metadata)
  VALUES (p_actor, p_partner, p_action, p_entity_type, p_entity_id, COALESCE(p_metadata,'{}'::jsonb));

  INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('partner.self_managed.' || p_action, p_partner, p_entity_type, p_entity_id,
          COALESCE(p_metadata,'{}'::jsonb) || jsonb_build_object('actor_id', p_actor));
EXCEPTION WHEN OTHERS THEN
  NULL; -- fire and forget: auditing must never break a money path
END;
$$;

CREATE OR REPLACE FUNCTION public.psm_is_partner(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    public.has_role(p_user,'supporter') OR public.has_role(p_user,'partner_ops')
    OR public.has_role(p_user,'super_admin') OR public.has_role(p_user,'manager'), false);
$$;

-- ---------------------------------------------------------------
-- 8. The funding window view: approved, awaiting money, not yet held
-- ---------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_partner_self_fundable_plans AS
SELECT
  rr.id                                        AS rent_request_id,
  rr.rent_amount                               AS funding_amount,
  rr.rent_amount,
  rr.duration_days,
  rr.daily_repayment,
  rr.total_repayment,
  rr.number_of_payments,
  rr.house_category,
  rr.request_city,
  rr.house_image_urls,
  rr.created_at                                AS posted_at,
  COALESCE(rr.coo_reviewed_at, rr.approved_at) AS approved_at,
  (CURRENT_DATE + (rr.duration_days || ' days')::interval)::date AS projected_end_date,
  CASE WHEN COALESCE(rr.number_of_payments,0) > 0
         AND rr.duration_days > 0
         AND (rr.duration_days::numeric / NULLIF(rr.number_of_payments,0)) >= 6
       THEN 'weekly' ELSE 'daily' END          AS repayment_cadence,
  c.id                                         AS active_claim_id,
  c.partner_id                                 AS held_by,
  c.expires_at                                 AS hold_expires_at
FROM public.rent_requests rr
LEFT JOIN public.partner_self_plan_claims c
       ON c.rent_request_id = rr.id
      AND c.status IN ('held','confirmed')
      AND (c.status = 'confirmed' OR c.expires_at > now())
WHERE rr.funded_at IS NULL
  AND rr.disbursed_at IS NULL
  AND rr.supporter_id IS NULL
  AND rr.self_funding_partner_id IS NULL
  AND rr.tenancy_status = 'active'
  AND rr.coo_reviewed_at IS NOT NULL
  AND rr.status IN ('pending','approved','agent_ops_approved','tenant_ops_approved',
                    'landlord_ops_approved','agent_verified','coo_approved');

-- No client grants on the view: reachable only through the definer RPCs below.

-- ---------------------------------------------------------------
-- 9. RPC: list fundable plans (single round trip, paginated, total inline)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_self_list_fundable_plans(
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_city text DEFAULT NULL,
  p_min_amount numeric DEFAULT NULL,
  p_max_amount numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb;
  v_total integer;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for self-managed funding' USING ERRCODE = '42501';
  END IF;

  WITH filtered AS (
    SELECT p.*, COUNT(*) OVER () AS total_count
    FROM public.v_partner_self_fundable_plans p
    WHERE (p.held_by IS NULL OR p.held_by = v_uid)
      AND (p_city IS NULL OR p.request_city ILIKE '%' || p_city || '%')
      AND (p_min_amount IS NULL OR p.funding_amount >= p_min_amount)
      AND (p_max_amount IS NULL OR p.funding_amount <= p_max_amount)
    ORDER BY p.approved_at ASC NULLS LAST, p.posted_at ASC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit,20), 100))
    OFFSET GREATEST(0, COALESCE(p_offset,0))
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(f) - 'total_count'), '[]'::jsonb), COALESCE(MAX(f.total_count),0)
  INTO v_rows, v_total
  FROM filtered f;

  RETURN jsonb_build_object(
    'plans', v_rows,
    'total', v_total,
    'available_balance', public.get_user_available_balance(v_uid),
    'hold_minutes', 10
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_self_list_fundable_plans(integer,integer,text,numeric,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_self_list_fundable_plans(integer,integer,text,numeric,numeric) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 10. RPC: claim plans (FIFO exclusive hold, idempotent, set-based)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_self_claim_plans(
  p_rent_request_ids uuid[],
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_expires timestamptz := now() + interval '10 minutes';
  v_claimed jsonb;
  v_lost jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for self-managed funding' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_ids IS NULL OR array_length(p_rent_request_ids,1) IS NULL THEN
    RAISE EXCEPTION 'No plans supplied';
  END IF;

  -- release this partner's own stale holds first (self-healing, no cron dependency)
  UPDATE public.partner_self_plan_claims
     SET status='expired', closed_at=now(), updated_at=now()
   WHERE status='held' AND expires_at <= now();

  INSERT INTO public.partner_self_plan_claims (rent_request_id, partner_id, amount, expires_at, idempotency_key)
  SELECT p.rent_request_id, v_uid, p.funding_amount, v_expires, p_idempotency_key
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = ANY(p_rent_request_ids)
    AND p.held_by IS NULL
  ON CONFLICT (rent_request_id) WHERE status IN ('held','confirmed') DO NOTHING;

  -- extend this partner's existing live holds in the same batch
  UPDATE public.partner_self_plan_claims
     SET expires_at = v_expires, updated_at = now()
   WHERE partner_id = v_uid AND status = 'held' AND rent_request_id = ANY(p_rent_request_ids);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'rent_request_id', c.rent_request_id,
           'amount', c.amount,
           'expires_at', c.expires_at)), '[]'::jsonb)
  INTO v_claimed
  FROM public.partner_self_plan_claims c
  WHERE c.partner_id = v_uid AND c.status IN ('held','confirmed')
    AND c.rent_request_id = ANY(p_rent_request_ids);

  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) INTO v_lost
  FROM unnest(p_rent_request_ids) AS x
  WHERE NOT EXISTS (
    SELECT 1 FROM public.partner_self_plan_claims c
    WHERE c.rent_request_id = x AND c.partner_id = v_uid AND c.status IN ('held','confirmed'));

  PERFORM public.psm_audit(v_uid, v_uid, 'plans_claimed', 'partner_self_plan_claims', NULL,
    jsonb_build_object('claimed', v_claimed, 'lost', v_lost, 'idempotency_key', p_idempotency_key));

  RETURN jsonb_build_object(
    'claimed', v_claimed,
    'lost_to_other_partners', v_lost,
    'hold_expires_at', v_expires,
    'available_balance', public.get_user_available_balance(v_uid)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_self_claim_plans(uuid[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_self_claim_plans(uuid[],text) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 11. RPC: release holds
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_self_release_claims(p_rent_request_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_count integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;

  UPDATE public.partner_self_plan_claims
     SET status='released', closed_at=now(), updated_at=now()
   WHERE partner_id = v_uid AND status='held'
     AND (p_rent_request_ids IS NULL OR rent_request_id = ANY(p_rent_request_ids));
  GET DIAGNOSTICS v_count = ROW_COUNT;

  PERFORM public.psm_audit(v_uid, v_uid, 'plans_released', 'partner_self_plan_claims', NULL,
    jsonb_build_object('released_count', v_count));
  RETURN jsonb_build_object('released', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.partner_self_release_claims(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_self_release_claims(uuid[]) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 12. RPC: confirm commitment (strict balance gate, ledger, FIFO linkage)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_self_confirm_commitment(
  p_rent_request_ids uuid[],
  p_term_months integer DEFAULT 12,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := COALESCE(NULLIF(p_idempotency_key,''), 'psm-' || v_uid::text || '-' || md5(array_to_string(p_rent_request_ids,',')));
  v_existing public.partner_self_commitments%ROWTYPE;
  v_commitment_id uuid;
  v_total numeric;
  v_count integer;
  v_available numeric;
  v_rate numeric := 15;
  v_entries jsonb;
  v_group uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for self-managed funding' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || v_uid::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
                              'committed_amount', v_existing.committed_amount,
                              'lines', v_existing.lines_count);
  END IF;

  -- validate holds belong to this partner and are still live
  SELECT COUNT(*), COALESCE(SUM(amount),0)
  INTO v_count, v_total
  FROM public.partner_self_plan_claims
  WHERE partner_id = v_uid AND status = 'held' AND expires_at > now()
    AND rent_request_id = ANY(p_rent_request_ids);

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_rent_request_ids,1),0) THEN
    RAISE EXCEPTION 'Some selections are no longer held by you. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- strict, ledger-backed spendable balance — never the cached wallet figure
  v_available := public.get_user_available_balance(v_uid);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'Selected plans total UGX %. Your wallet has UGX % available. You are UGX % over.',
      round(v_total), round(v_available), round(v_total - v_available)
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key
  ) VALUES (
    v_uid, v_total, GREATEST(1, LEAST(COALESCE(p_term_months,12), 60)), v_rate, v_count, v_key
  ) RETURNING id INTO v_commitment_id;

  INSERT INTO public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months
  )
  SELECT v_commitment_id, v_uid, c.rent_request_id, c.amount, v_rate,
         GREATEST(1, LEAST(COALESCE(p_term_months,12), 60))
  FROM public.partner_self_plan_claims c
  WHERE c.partner_id = v_uid AND c.status='held' AND c.rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.partner_self_plan_claims
     SET status='confirmed', confirmed_at=now(), commitment_id=v_commitment_id, updated_at=now()
   WHERE partner_id = v_uid AND status='held' AND rent_request_id = ANY(p_rent_request_ids);

  -- link plan -> partner (supporter_id intentionally untouched)
  UPDATE public.rent_requests rr
     SET self_funding_partner_id = v_uid,
         self_funding_line_id = l.id,
         updated_at = now()
  FROM public.partner_self_funding_lines l
  WHERE l.commitment_id = v_commitment_id AND rr.id = l.rent_request_id;

  -- ledger: one balanced transaction, one leg pair per line
  SELECT jsonb_agg(e) INTO v_entries FROM (
    SELECT jsonb_build_object(
      'user_id', v_uid, 'amount', l.principal, 'direction', 'cash_out',
      'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
      'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'partner_self_funding_lines', 'source_id', l.id,
      'reference_id', l.rent_request_id::text,
      'description', 'Self-managed partner funding committed'
    ) AS e
    FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_commitment_id
    UNION ALL
    SELECT jsonb_build_object(
      'amount', l.principal, 'direction', 'cash_in',
      'category', 'partner_funding', 'ledger_scope', 'platform',
      'source_table', 'partner_self_funding_lines', 'source_id', l.id,
      'reference_id', l.rent_request_id::text,
      'linked_party', v_uid::text,
      'description', 'Self-managed partner capital received'
    )
    FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_commitment_id
  ) s;

  v_group := public.create_ledger_transaction(
    entries := v_entries,
    idempotency_key := 'psm-commit-' || v_commitment_id::text
  );

  UPDATE public.partner_self_commitments
     SET ledger_group_id = v_group, updated_at = now()
   WHERE id = v_commitment_id;

  PERFORM public.psm_audit(v_uid, v_uid, 'commitment_confirmed', 'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'lines', v_count, 'term_months', p_term_months,
                       'ledger_group_id', v_group, 'available_before', v_available));

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'committed_amount', v_total, 'lines', v_count,
    'monthly_return', round(v_total * v_rate / 100), 'ledger_group_id', v_group,
    'available_balance', public.get_user_available_balance(v_uid)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_self_confirm_commitment(uuid[],integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_self_confirm_commitment(uuid[],integer,text) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 13. Line goes live the day that line's landlord is actually paid
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.psm_activate_line_on_disbursement()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_line public.partner_self_funding_lines%ROWTYPE; v_live timestamptz;
BEGIN
  BEGIN
    IF NEW.self_funding_partner_id IS NULL THEN RETURN NEW; END IF;
    v_live := COALESCE(NEW.disbursed_at, NEW.funded_at);
    IF v_live IS NULL THEN RETURN NEW; END IF;

    UPDATE public.partner_self_funding_lines
       SET status='earning', live_at=v_live,
           term_end_at = v_live + (term_months || ' months')::interval,
           updated_at = now()
     WHERE rent_request_id = NEW.id AND status='idle'
    RETURNING * INTO v_line;

    IF v_line.id IS NULL THEN RETURN NEW; END IF;

    -- partner payout clock is anchored once, by the first line to go live
    UPDATE public.partner_self_commitments
       SET payout_anchor_at = v_live,
           payout_day = EXTRACT(DAY FROM v_live)::smallint,
           next_payout_at = v_live + interval '1 month',
           term_end_at = v_live + (term_months || ' months')::interval,
           updated_at = now()
     WHERE id = v_line.commitment_id AND payout_anchor_at IS NULL;

    PERFORM public.psm_audit(NULL, v_line.partner_id, 'line_activated',
      'partner_self_funding_lines', v_line.id,
      jsonb_build_object('rent_request_id', NEW.id, 'live_at', v_live, 'principal', v_line.principal));
  EXCEPTION WHEN OTHERS THEN
    NULL; -- never block the existing disbursement path
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_psm_activate_line ON public.rent_requests;
CREATE TRIGGER trg_psm_activate_line
AFTER UPDATE OF disbursed_at, funded_at ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.psm_activate_line_on_disbursement();

-- close a line when the plan completes (capital available to recycle)
CREATE OR REPLACE FUNCTION public.psm_complete_line_on_plan_close()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF NEW.self_funding_partner_id IS NULL THEN RETURN NEW; END IF;
    IF NEW.status IN ('completed','fully_repaid') AND COALESCE(OLD.status,'') <> NEW.status THEN
      UPDATE public.partner_self_funding_lines
         SET status='completed', completed_at=now(), updated_at=now()
       WHERE rent_request_id = NEW.id AND status='earning';
      PERFORM public.psm_audit(NULL, NEW.self_funding_partner_id, 'line_completed',
        'rent_requests', NEW.id, jsonb_build_object('status', NEW.status));
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_psm_complete_line ON public.rent_requests;
CREATE TRIGGER trg_psm_complete_line
AFTER UPDATE OF status ON public.rent_requests
FOR EACH ROW EXECUTE FUNCTION public.psm_complete_line_on_plan_close();

-- ---------------------------------------------------------------
-- 14. Sweeper: expire stale holds
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_partner_self_claims()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.partner_self_plan_claims
     SET status='expired', closed_at=now(), updated_at=now()
   WHERE status='held' AND expires_at <= now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    PERFORM public.psm_audit(NULL, NULL, 'claims_expired', NULL, NULL, jsonb_build_object('count', v_count));
  END IF;
  RETURN jsonb_build_object('expired', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.expire_partner_self_claims() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_partner_self_claims() TO service_role;

-- ---------------------------------------------------------------
-- 15. Accrual: recognise what is owed, per line, pro-rata, set-based
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accrue_partner_self_returns(p_as_of date DEFAULT CURRENT_DATE)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_cycle_start date;
  v_cycle_end date;
  v_days integer;
  v_total numeric;
  v_lines integer;
  v_cycle_id uuid;
  v_commitments integer := 0;
  v_recognised numeric := 0;
BEGIN
  FOR r IN
    SELECT * FROM public.partner_self_commitments
    WHERE status='active' AND next_payout_at IS NOT NULL AND next_payout_at::date <= p_as_of
    ORDER BY next_payout_at ASC
  LOOP
    v_cycle_end := r.next_payout_at::date;
    v_cycle_start := (r.next_payout_at - interval '1 month')::date;
    v_days := GREATEST(1, v_cycle_end - v_cycle_start);

    INSERT INTO public.partner_self_payout_cycles (partner_id, commitment_id, cycle_start, cycle_end)
    VALUES (r.partner_id, r.id, v_cycle_start, v_cycle_end)
    ON CONFLICT (commitment_id, cycle_end) DO UPDATE SET updated_at = now()
    RETURNING id INTO v_cycle_id;

    INSERT INTO public.partner_self_earnings (
      line_id, commitment_id, partner_id, cycle_start, cycle_end,
      days_live, days_in_cycle, principal, monthly_rate, amount, payout_cycle_id
    )
    SELECT l.id, r.id, r.partner_id, v_cycle_start, v_cycle_end,
           d.days_live, v_days, l.principal, l.monthly_rate,
           round(l.principal * l.monthly_rate / 100 * d.days_live::numeric / v_days),
           v_cycle_id
    FROM public.partner_self_funding_lines l
    CROSS JOIN LATERAL (
      SELECT GREATEST(0,
        LEAST(v_cycle_end, COALESCE(l.completed_at::date, v_cycle_end))
        - GREATEST(v_cycle_start, l.live_at::date)
      ) AS days_live
    ) d
    WHERE l.commitment_id = r.id
      AND l.live_at IS NOT NULL
      AND l.status IN ('earning','completed')
      AND d.days_live > 0
    ON CONFLICT (line_id, cycle_end) DO NOTHING;

    SELECT COALESCE(SUM(amount),0), COUNT(*) INTO v_total, v_lines
    FROM public.partner_self_earnings WHERE payout_cycle_id = v_cycle_id AND status <> 'void';

    UPDATE public.partner_self_payout_cycles
       SET total_amount = v_total, lines_count = v_lines, updated_at = now()
     WHERE id = v_cycle_id;

    UPDATE public.partner_self_commitments
       SET next_payout_at = next_payout_at + interval '1 month',
           total_earned = total_earned + v_total,
           status = CASE WHEN term_end_at IS NOT NULL AND (next_payout_at + interval '1 month') > term_end_at
                         THEN 'matured' ELSE status END,
           updated_at = now()
     WHERE id = r.id;

    v_commitments := v_commitments + 1;
    v_recognised := v_recognised + v_total;

    PERFORM public.psm_audit(NULL, r.partner_id, 'returns_recognised',
      'partner_self_payout_cycles', v_cycle_id,
      jsonb_build_object('cycle_end', v_cycle_end, 'amount', v_total, 'lines', v_lines));
  END LOOP;

  RETURN jsonb_build_object('commitments_processed', v_commitments, 'total_recognised', v_recognised);
END;
$$;

REVOKE ALL ON FUNCTION public.accrue_partner_self_returns(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accrue_partner_self_returns(date) TO service_role;

-- ---------------------------------------------------------------
-- 16. RPC: the partner's whole self-managed book in ONE round trip
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_self_portfolio(p_partner_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_target uuid := COALESCE(p_partner_id, auth.uid());
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF v_target <> v_uid AND NOT (
      public.is_ops_role(v_uid) OR public.has_role(v_uid,'cfo') OR public.has_role(v_uid,'coo')
      OR public.has_role(v_uid,'ceo') OR public.has_role(v_uid,'manager') OR public.has_role(v_uid,'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501';
  END IF;

  RETURN (
    WITH commitments AS (
      SELECT * FROM public.partner_self_commitments WHERE partner_id = v_target
    ),
    lines AS (
      SELECT l.*, rr.rent_amount, rr.duration_days, rr.daily_repayment,
             rr.request_city, rr.house_category, rr.status AS plan_status,
             rr.disbursed_at, rr.amount_repaid
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      WHERE l.partner_id = v_target AND l.status <> 'cancelled'
    ),
    holds AS (
      SELECT * FROM public.partner_self_plan_claims
      WHERE partner_id = v_target AND status='held' AND expires_at > now()
    ),
    payouts AS (
      SELECT * FROM public.partner_self_payout_cycles WHERE partner_id = v_target
    )
    SELECT jsonb_build_object(
      'available_balance', public.get_user_available_balance(v_target),
      'totals', jsonb_build_object(
        'committed', (SELECT COALESCE(SUM(committed_amount),0) FROM commitments WHERE status <> 'cancelled'),
        'earning', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='earning'),
        'idle', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='idle'),
        'completed', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='completed'),
        'total_earned', (SELECT COALESCE(SUM(total_earned),0) FROM commitments),
        'total_paid', (SELECT COALESCE(SUM(total_paid),0) FROM commitments),
        'lines_count', (SELECT COUNT(*) FROM lines)
      ),
      'commitments', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC), '[]'::jsonb) FROM commitments c),
      'lines', (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC), '[]'::jsonb) FROM lines l),
      'active_holds', (SELECT COALESCE(jsonb_agg(to_jsonb(h)), '[]'::jsonb) FROM holds h),
      'payout_cycles', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.cycle_end DESC), '[]'::jsonb) FROM payouts p),
      'next_payout', (SELECT jsonb_build_object('date', MIN(next_payout_at))
                        FROM commitments WHERE status='active' AND next_payout_at IS NOT NULL)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_self_portfolio(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_self_portfolio(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 17. updated_at maintenance
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.psm_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_psm_touch_commitments ON public.partner_self_commitments;
CREATE TRIGGER trg_psm_touch_commitments BEFORE UPDATE ON public.partner_self_commitments
FOR EACH ROW EXECUTE FUNCTION public.psm_touch_updated_at();

DROP TRIGGER IF EXISTS trg_psm_touch_lines ON public.partner_self_funding_lines;
CREATE TRIGGER trg_psm_touch_lines BEFORE UPDATE ON public.partner_self_funding_lines
FOR EACH ROW EXECUTE FUNCTION public.psm_touch_updated_at();

DROP TRIGGER IF EXISTS trg_psm_touch_claims ON public.partner_self_plan_claims;
CREATE TRIGGER trg_psm_touch_claims BEFORE UPDATE ON public.partner_self_plan_claims
FOR EACH ROW EXECUTE FUNCTION public.psm_touch_updated_at();

DROP TRIGGER IF EXISTS trg_psm_touch_payouts ON public.partner_self_payout_cycles;
CREATE TRIGGER trg_psm_touch_payouts BEFORE UPDATE ON public.partner_self_payout_cycles
FOR EACH ROW EXECUTE FUNCTION public.psm_touch_updated_at();