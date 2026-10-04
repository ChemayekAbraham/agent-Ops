-- =====================================================================
-- Self Portfolio Management — Top-ups, immediate accrual, 12-month term
-- Greenfield PSM tables only. Touches nothing in investor_portfolios,
-- process-supporter-roi, or any managed-portfolio object.
-- =====================================================================

-- ---------------------------------------------------------------
-- 1. Top-up record
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_self_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  commitment_id uuid NOT NULL REFERENCES public.partner_self_commitments(id) ON DELETE CASCADE,
  amount numeric NOT NULL CHECK (amount > 0),
  lines_count integer NOT NULL DEFAULT 0,
  effective_at timestamptz NOT NULL DEFAULT now(),
  prorata_days integer NOT NULL DEFAULT 0,
  days_in_cycle integer NOT NULL DEFAULT 30,
  prorata_amount numeric NOT NULL DEFAULT 0,
  inherits_term_end_at timestamptz,
  idempotency_key text,
  ledger_group_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_psm_topup_idempotency
  ON public.partner_self_topups (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_psm_topup_commitment
  ON public.partner_self_topups (commitment_id, effective_at DESC);

GRANT SELECT ON public.partner_self_topups TO authenticated;
GRANT ALL ON public.partner_self_topups TO service_role;
ALTER TABLE public.partner_self_topups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "psm topups readable by owner" ON public.partner_self_topups;
CREATE POLICY "psm topups readable by owner"
  ON public.partner_self_topups FOR SELECT TO authenticated
  USING (partner_id = auth.uid());

DROP POLICY IF EXISTS "psm topups readable by ops" ON public.partner_self_topups;
CREATE POLICY "psm topups readable by ops"
  ON public.partner_self_topups FOR SELECT TO authenticated
  USING (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'ceo') OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin')
  );

DROP TRIGGER IF EXISTS trg_psm_topups_touch ON public.partner_self_topups;
CREATE TRIGGER trg_psm_topups_touch
BEFORE UPDATE ON public.partner_self_topups
FOR EACH ROW EXECUTE FUNCTION public.psm_touch_updated_at();

-- ---------------------------------------------------------------
-- 2. Capital earns from deployment, not from landlord payout.
--    A line is live the moment it exists; top-up lines inherit the
--    parent portfolio maturity date so a top-up never extends term.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.psm_line_live_on_create()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_parent_end timestamptz;
BEGIN
  IF NEW.live_at IS NULL THEN
    NEW.live_at := now();
  END IF;
  IF NEW.status = 'idle' THEN
    NEW.status := 'active';
  END IF;

  SELECT term_end_at INTO v_parent_end
    FROM public.partner_self_commitments WHERE id = NEW.commitment_id;

  NEW.term_end_at := COALESCE(
    v_parent_end,
    NEW.live_at + (GREATEST(1, COALESCE(NEW.term_months, 12)) || ' months')::interval
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_psm_line_live_on_create ON public.partner_self_funding_lines;
CREATE TRIGGER trg_psm_line_live_on_create
BEFORE INSERT ON public.partner_self_funding_lines
FOR EACH ROW EXECUTE FUNCTION public.psm_line_live_on_create();

-- anchor the portfolio clock on the first deployed line
CREATE OR REPLACE FUNCTION public.psm_anchor_commitment_on_first_line()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.partner_self_commitments c
     SET payout_anchor_at = NEW.live_at,
         payout_day       = EXTRACT(DAY FROM NEW.live_at)::smallint,
         next_payout_at   = NEW.live_at + interval '1 month',
         term_end_at      = NEW.live_at + (GREATEST(1, COALESCE(c.term_months, 12)) || ' months')::interval,
         updated_at       = now()
   WHERE c.id = NEW.commitment_id
     AND c.payout_anchor_at IS NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_psm_anchor_commitment ON public.partner_self_funding_lines;
CREATE TRIGGER trg_psm_anchor_commitment
AFTER INSERT ON public.partner_self_funding_lines
FOR EACH ROW EXECUTE FUNCTION public.psm_anchor_commitment_on_first_line();

-- ---------------------------------------------------------------
-- 3. Returns never accrue past portfolio maturity
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accrue_partner_self_returns(p_as_of date DEFAULT CURRENT_DATE)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
  v_as_of date := LEAST(COALESCE(p_as_of, CURRENT_DATE), CURRENT_DATE);
BEGIN
  FOR r IN
    SELECT * FROM public.partner_self_commitments
    WHERE status='active' AND next_payout_at IS NOT NULL AND next_payout_at::date <= v_as_of
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
        LEAST(
          v_cycle_end,
          COALESCE(l.completed_at::date, v_cycle_end),
          -- maturity clamp: no line earns beyond the portfolio term end
          COALESCE(COALESCE(r.term_end_at, l.term_end_at)::date, v_cycle_end)
        )
        - GREATEST(v_cycle_start, l.live_at::date)
      ) AS days_live
    ) d
    WHERE l.commitment_id = r.id
      AND l.live_at IS NOT NULL
      AND l.status IN ('active','completed')
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

  RETURN jsonb_build_object('commitments_processed', v_commitments, 'total_recognised', v_recognised, 'as_of', v_as_of);
END;
$fn$;

-- ---------------------------------------------------------------
-- 4. Can this portfolio take a top-up, and what would it earn?
--    Final 90 days = principal-return runway, top-ups blocked there.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_self_topup_eligibility(p_commitment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  c public.partner_self_commitments%ROWTYPE;
  v_days_remaining integer;
  v_cycles_remaining integer;
  v_cycle_start date;
  v_cycle_end date;
  v_days_in_cycle integer;
  v_days_left_in_cycle integer;
  v_allow boolean;
  v_reason text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO c FROM public.partner_self_commitments
   WHERE id = p_commitment_id AND partner_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'no_data_found';
  END IF;

  v_days_remaining   := GREATEST(0, COALESCE(c.term_end_at::date, CURRENT_DATE) - CURRENT_DATE);
  v_cycles_remaining := GREATEST(0, floor(v_days_remaining::numeric / 30)::integer);

  v_cycle_end   := COALESCE(c.next_payout_at::date, CURRENT_DATE + 30);
  v_cycle_start := (COALESCE(c.next_payout_at, now() + interval '1 month') - interval '1 month')::date;
  v_days_in_cycle      := GREATEST(1, v_cycle_end - v_cycle_start);
  v_days_left_in_cycle := GREATEST(0, v_cycle_end - CURRENT_DATE);

  IF c.status <> 'active' THEN
    v_allow := false;
    v_reason := 'This portfolio is ' || c.status || '. New capital starts a fresh 12-month portfolio.';
  ELSIF c.term_end_at IS NOT NULL AND v_days_remaining <= 90 THEN
    v_allow := false;
    v_reason := 'This portfolio matures in ' || v_days_remaining
             || ' days. The final 90 days are reserved for returning principal, so new capital starts a fresh 12-month portfolio.';
  ELSE
    v_allow := true;
    v_reason := NULL;
  END IF;

  RETURN jsonb_build_object(
    'commitment_id', c.id,
    'status', c.status,
    'committed_amount', c.committed_amount,
    'monthly_rate', c.monthly_rate,
    'term_end_at', c.term_end_at,
    'next_payout_at', c.next_payout_at,
    'days_remaining', v_days_remaining,
    'cycles_remaining', v_cycles_remaining,
    'days_in_cycle', v_days_in_cycle,
    'days_left_in_cycle', v_days_left_in_cycle,
    'allow_topup', v_allow,
    'block_reason', v_reason,
    'available_balance', public.get_user_available_balance(v_uid)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_self_topup_eligibility(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_self_topup_eligibility(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------
-- 5. Top up an existing portfolio (immediate, pro-rata this cycle)
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_self_top_up(
  p_commitment_id uuid,
  p_rent_request_ids uuid[],
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := COALESCE(NULLIF(p_idempotency_key, ''), gen_random_uuid()::text);
  c public.partner_self_commitments%ROWTYPE;
  v_existing public.partner_self_topups%ROWTYPE;
  v_elig jsonb;
  v_total numeric;
  v_count integer;
  v_available numeric;
  v_topup_id uuid;
  v_entries jsonb;
  v_group uuid;
  v_days_left integer;
  v_days_in_cycle integer;
  v_prorata numeric;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for self-managed funding' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-topup-' || v_uid::text));

  SELECT * INTO v_existing FROM public.partner_self_topups WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('topup_id', v_existing.id, 'idempotent_replay', true,
                              'amount', v_existing.amount, 'lines', v_existing.lines_count);
  END IF;

  SELECT * INTO c FROM public.partner_self_commitments
   WHERE id = p_commitment_id AND partner_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'no_data_found';
  END IF;

  v_elig := public.partner_self_topup_eligibility(p_commitment_id);
  IF NOT (v_elig->>'allow_topup')::boolean THEN
    RAISE EXCEPTION 'PSM_TOPUP_WINDOW_CLOSED: %', COALESCE(v_elig->>'block_reason', 'Top-up not allowed')
      USING ERRCODE = 'check_violation';
  END IF;

  -- selections must be live holds owned by this partner
  SELECT COUNT(*), COALESCE(SUM(amount),0) INTO v_count, v_total
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
    RAISE EXCEPTION 'Top-up totals UGX %. Your wallet has UGX % available. You are UGX % over.',
      round(v_total), round(v_available), round(v_total - v_available)
      USING ERRCODE = 'check_violation';
  END IF;

  v_days_in_cycle := GREATEST(1, (v_elig->>'days_in_cycle')::integer);
  v_days_left     := GREATEST(0, LEAST((v_elig->>'days_left_in_cycle')::integer, v_days_in_cycle));
  v_prorata       := round(v_total * c.monthly_rate / 100 * v_days_left::numeric / v_days_in_cycle);

  INSERT INTO public.partner_self_topups (
    partner_id, commitment_id, amount, lines_count, prorata_days,
    days_in_cycle, prorata_amount, inherits_term_end_at, idempotency_key
  ) VALUES (
    v_uid, c.id, v_total, v_count, v_days_left,
    v_days_in_cycle, v_prorata, c.term_end_at, v_key
  ) RETURNING id INTO v_topup_id;

  -- new lines: live immediately, inheriting parent maturity (trigger enforces)
  INSERT INTO public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months
  )
  SELECT c.id, v_uid, cl.rent_request_id, cl.amount, c.monthly_rate, c.term_months
  FROM public.partner_self_plan_claims cl
  WHERE cl.partner_id = v_uid AND cl.status='held'
    AND cl.rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.partner_self_plan_claims
     SET status='confirmed', confirmed_at=now(), commitment_id=c.id, updated_at=now()
   WHERE partner_id = v_uid AND status='held' AND rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.rent_requests rr
     SET self_funding_partner_id = v_uid,
         self_funding_line_id = l.id,
         updated_at = now()
  FROM public.partner_self_funding_lines l
  WHERE l.commitment_id = c.id
    AND l.rent_request_id = ANY(p_rent_request_ids)
    AND rr.id = l.rent_request_id
    AND rr.self_funding_partner_id IS NULL;

  -- ledger: partner withdrawable -> company landlord-float pool
  v_entries := jsonb_build_array(
    jsonb_build_object(
      'user_id', v_uid, 'amount', v_total, 'direction', 'cash_out',
      'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
      'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'partner_self_topups', 'source_id', v_topup_id,
      'description', 'Self-managed portfolio top-up'
    ),
    jsonb_build_object(
      'amount', v_total, 'direction', 'cash_in',
      'category', 'partner_funding', 'ledger_scope', 'platform',
      'source_table', 'partner_self_topups', 'source_id', v_topup_id,
      'linked_party', v_uid::text,
      'description', 'Self-managed partner top-up capital received'
    )
  );

  v_group := public.create_ledger_transaction(
    entries := v_entries,
    idempotency_key := 'psm-topup-' || v_topup_id::text
  );

  UPDATE public.partner_self_topups
     SET ledger_group_id = v_group, updated_at = now()
   WHERE id = v_topup_id;

  UPDATE public.partner_self_commitments
     SET committed_amount = committed_amount + v_total,
         lines_count = lines_count + v_count,
         updated_at = now()
   WHERE id = c.id;

  PERFORM public.psm_audit(v_uid, v_uid, 'commitment_topped_up',
    'partner_self_topups', v_topup_id,
    jsonb_build_object('commitment_id', c.id, 'amount', v_total, 'lines', v_count,
                       'prorata_days', v_days_left, 'days_in_cycle', v_days_in_cycle,
                       'prorata_amount', v_prorata, 'inherits_term_end_at', c.term_end_at,
                       'ledger_group_id', v_group, 'available_before', v_available));

  RETURN jsonb_build_object(
    'topup_id', v_topup_id,
    'commitment_id', c.id,
    'amount', v_total,
    'lines', v_count,
    'prorata_days', v_days_left,
    'days_in_cycle', v_days_in_cycle,
    'prorata_amount', v_prorata,
    'full_monthly_return', round(v_total * c.monthly_rate / 100),
    'term_end_at', c.term_end_at,
    'ledger_group_id', v_group,
    'available_balance', public.get_user_available_balance(v_uid)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_self_top_up(uuid,uuid[],text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_self_top_up(uuid,uuid[],text) TO authenticated, service_role;