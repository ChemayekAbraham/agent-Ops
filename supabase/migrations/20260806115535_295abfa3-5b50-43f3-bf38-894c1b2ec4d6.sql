-- 1. Columns
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS payout_route_ref text,
  ADD COLUMN IF NOT EXISTS intent_key text;

COMMENT ON COLUMN public.withdrawal_requests.intent_key IS
  'Deterministic replay-protection fingerprint for proxy withdrawals. Computed server-side by trg_set_withdrawal_intent_key. Never set from the client.';
COMMENT ON COLUMN public.withdrawal_requests.payout_route_ref IS
  'Route the requester picked: "portfolio:<uuid>" or "saved:<uuid>". Used to resolve the payout cycle for intent_key.';

-- 2. Deterministic key builder
CREATE OR REPLACE FUNCTION public.compute_withdrawal_intent_key(
  p_partner_id uuid,
  p_agent_id uuid,
  p_amount numeric,
  p_payout_method text,
  p_route_ref text,
  p_momo_number text,
  p_bank_account_number text,
  p_created_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dest text;
  v_cycle text;
  v_portfolio_id uuid;
  v_code text;
  v_next_roi date;
BEGIN
  v_dest := coalesce(
    nullif(regexp_replace(coalesce(p_bank_account_number, ''), '\D', '', 'g'), ''),
    nullif(regexp_replace(coalesce(p_momo_number, ''), '\D', '', 'g'), ''),
    'nodest'
  );

  -- Cycle tag: a portfolio route pins the key to that portfolio's CURRENT payout
  -- cycle, so a re-tap inside the same cycle repeats the key forever, while the
  -- next legitimate cycle produces a different key.
  IF p_route_ref LIKE 'portfolio:%' THEN
    BEGIN
      v_portfolio_id := substring(p_route_ref from 11)::uuid;
    EXCEPTION WHEN others THEN
      v_portfolio_id := NULL;
    END;
  END IF;

  IF v_portfolio_id IS NOT NULL THEN
    SELECT portfolio_code, next_roi_date
      INTO v_code, v_next_roi
    FROM public.investor_portfolios
    WHERE id = v_portfolio_id;
  END IF;

  IF v_code IS NOT NULL THEN
    v_cycle := 'pf:' || v_code || '#' || coalesce(v_next_roi::text, 'nocycle');
  ELSIF p_route_ref IS NOT NULL THEN
    v_cycle := p_route_ref || '#' || to_char(coalesce(p_created_at, now()), 'YYYY-MM');
  ELSE
    v_cycle := 'noroute#' || to_char(coalesce(p_created_at, now()), 'YYYY-MM-DD');
  END IF;

  RETURN encode(
    digest(
      concat_ws('|',
        'proxy_withdrawal_v1',
        p_partner_id::text,
        coalesce(p_agent_id::text, 'noagent'),
        trim(to_char(round(coalesce(p_amount, 0)), 'FM9999999999999')),
        coalesce(p_payout_method, 'nomethod'),
        v_dest,
        v_cycle
      ),
      'sha256'
    ),
    'hex'
  );
END;
$$;

-- 3. Trigger: server-computed key + claim-before-act check
CREATE OR REPLACE FUNCTION public.set_withdrawal_intent_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing record;
BEGIN
  -- Only proxy-initiated withdrawals participate. Never trust a client value.
  IF NEW.proxy_partner_id IS NULL THEN
    NEW.intent_key := NULL;
    RETURN NEW;
  END IF;

  NEW.intent_key := public.compute_withdrawal_intent_key(
    NEW.user_id,
    coalesce(NEW.initiated_by, NEW.agent_id),
    NEW.amount,
    NEW.payout_method,
    NEW.payout_route_ref,
    NEW.mobile_money_number,
    NEW.bank_account_number,
    coalesce(NEW.created_at, now())
  );

  SELECT id, status, created_at
    INTO v_existing
  FROM public.withdrawal_requests
  WHERE intent_key = NEW.intent_key
    AND id <> NEW.id
    AND status NOT IN ('cancelled', 'rejected', 'expired', 'failed')
  ORDER BY created_at
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RAISE EXCEPTION
      'DUPLICATE_WITHDRAWAL_INTENT: this exact payout was already requested on % (request %, status %). Cancel or reject that request before requesting it again.',
      to_char(v_existing.created_at, 'DD Mon YYYY HH24:MI'),
      v_existing.id,
      v_existing.status
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_withdrawal_intent_key ON public.withdrawal_requests;
CREATE TRIGGER trg_set_withdrawal_intent_key
  BEFORE INSERT ON public.withdrawal_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_withdrawal_intent_key();

-- 4. The hard constraint (backstop against a true concurrent race)
CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_requests_intent_key_uq
  ON public.withdrawal_requests (intent_key)
  WHERE intent_key IS NOT NULL
    AND status NOT IN ('cancelled', 'rejected', 'expired', 'failed');
