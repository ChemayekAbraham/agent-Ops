-- 1. Normalize free-text bank names to the supported bank ids used in the
--    merchant permission matrix (cashout_agents.config -> banks).
CREATE OR REPLACE FUNCTION public.normalize_payout_bank_id(p_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE s text;
BEGIN
  s := lower(coalesce(p_name, ''));
  s := regexp_replace(s, '[^a-z]+', ' ', 'g');
  s := btrim(s);
  IF s = '' THEN RETURN NULL; END IF;
  IF s LIKE '%stanbic%' THEN RETURN 'stanbic'; END IF;
  IF s LIKE '%centenary%' OR s LIKE '%centinary%' THEN RETURN 'centenary'; END IF;
  IF s LIKE '%dfcu%' THEN RETURN 'dfcu'; END IF;
  IF s LIKE '%equity%' THEN RETURN 'equity'; END IF;
  IF s LIKE '%post bank%' OR s LIKE '%postbank%' THEN RETURN 'postbank'; END IF;
  IF s LIKE '%housing finance%' OR s LIKE '%housingfinance%' THEN RETURN 'housing_finance'; END IF;
  RETURN NULL;
END;
$$;

-- 2. Channel + exact provider/bank eligibility for a merchant (cash-out) agent.
CREATE OR REPLACE FUNCTION public.merchant_handles_payout(
  p_agent_id uuid,
  p_payout_method text,
  p_provider text,
  p_bank_name text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ca public.cashout_agents%ROWTYPE;
  v_cfg jsonb;
  v_channel text;
  v_provider text;
  v_method text := lower(coalesce(p_payout_method, ''));
BEGIN
  SELECT * INTO v_ca FROM public.cashout_agents WHERE agent_id = p_agent_id LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Resolve channel + specific provider from the withdrawal row.
  IF v_method LIKE '%bank%' THEN
    v_channel := 'bank';
    v_provider := public.normalize_payout_bank_id(p_bank_name);
  ELSIF v_method LIKE '%cash%' OR v_method LIKE '%pickup%' THEN
    v_channel := 'cash';
    v_provider := NULL;
  ELSE
    v_channel := 'momo';
    v_provider := CASE
      WHEN lower(coalesce(p_provider, '')) LIKE '%mtn%' THEN 'mtn'
      WHEN lower(coalesce(p_provider, '')) LIKE '%airtel%' THEN 'airtel'
      ELSE NULL END;
  END IF;

  v_cfg := v_ca.config;

  -- Legacy merchants with no saved matrix: fall back to the boolean columns.
  IF v_cfg IS NULL OR v_cfg->'channels' IS NULL THEN
    IF v_channel = 'cash' THEN RETURN coalesce(v_ca.handles_cash, true); END IF;
    IF v_channel = 'bank' THEN RETURN coalesce(v_ca.handles_bank, true); END IF;
    IF v_provider = 'mtn' THEN RETURN coalesce(v_ca.handles_mtn, true); END IF;
    IF v_provider = 'airtel' THEN RETURN coalesce(v_ca.handles_airtel, true); END IF;
    RETURN coalesce(v_ca.handles_mtn, true) OR coalesce(v_ca.handles_airtel, true);
  END IF;

  -- Parent channel must be enabled.
  IF coalesce((v_cfg->'channels'->>v_channel)::boolean, false) = false THEN
    RETURN false;
  END IF;

  -- Unknown provider (bank outside the supported list, or momo with no network
  -- recorded): route on the channel flag alone so payouts are never stranded.
  IF v_provider IS NULL THEN RETURN true; END IF;

  IF v_channel = 'momo' THEN
    RETURN coalesce((v_cfg->'networks'->>v_provider)::boolean, false);
  ELSIF v_channel = 'bank' THEN
    RETURN coalesce((v_cfg->'banks'->>v_provider)::boolean, false);
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.normalize_payout_bank_id(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.merchant_handles_payout(uuid, text, text, text) TO authenticated, service_role;

-- 3. Auto-dispatch must validate channel AND exact provider/bank.
CREATE OR REPLACE FUNCTION public.auto_dispatch_withdrawals(p_batch_size integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_run_id uuid;
  v_dispatched int := 0;
  v_rec RECORD;
  v_agent_id uuid;
BEGIN
  INSERT INTO batch_processing_runs (run_type) VALUES ('auto_dispatch_withdrawals') RETURNING id INTO v_run_id;

  FOR v_rec IN
    SELECT wr.id, wr.amount, wr.payout_method, wr.mobile_money_provider, wr.bank_name
    FROM withdrawal_requests wr
    WHERE wr.status = 'cfo_approved'
      AND wr.assigned_cashout_agent_id IS NULL
      AND wr.auto_dispatched = false
    ORDER BY
      CASE WHEN wr.amount >= 500000 THEN 0 ELSE 1 END,
      wr.created_at ASC
    LIMIT p_batch_size
  LOOP
    UPDATE withdrawal_requests SET priority_level =
      CASE WHEN v_rec.amount >= 500000 THEN 'vip'
           WHEN v_rec.amount >= 100000 THEN 'high'
           ELSE 'standard' END
    WHERE id = v_rec.id;

    v_agent_id := NULL;

    SELECT ca.agent_id INTO v_agent_id
    FROM cashout_agents ca
    WHERE ca.is_active = true
      AND ca.current_queue_count < ca.max_daily_payouts
      AND public.merchant_handles_payout(
            ca.agent_id, v_rec.payout_method, v_rec.mobile_money_provider, v_rec.bank_name
          )
    ORDER BY ca.current_queue_count ASC
    LIMIT 1;

    IF v_agent_id IS NOT NULL THEN
      UPDATE withdrawal_requests
      SET assigned_cashout_agent_id = v_agent_id,
          auto_dispatched = true,
          dispatched_at = now()
      WHERE id = v_rec.id;

      UPDATE cashout_agents
      SET current_queue_count = current_queue_count + 1
      WHERE agent_id = v_agent_id;

      v_dispatched := v_dispatched + 1;
    END IF;
  END LOOP;

  UPDATE batch_processing_runs
  SET completed_at = now(), records_processed = v_dispatched, records_dispatched = v_dispatched
  WHERE id = v_run_id;

  RETURN jsonb_build_object('run_id', v_run_id, 'dispatched', v_dispatched);
END;
$function$;

-- 4. Claiming a dispatched withdrawal must also validate provider/bank.
CREATE OR REPLACE FUNCTION public.accept_withdrawal_dispatch(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id uuid := auth.uid();
  v_row public.withdrawal_requests%ROWTYPE;
  v_open_statuses text[] := ARRAY['pending','requested','manager_approved','cfo_approved','fin_ops_approved'];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.cashout_agents
     WHERE agent_id = v_agent_id AND is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_merchant_agent');
  END IF;

  SELECT * INTO v_row
    FROM public.withdrawal_requests
   WHERE id = p_withdrawal_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  -- Channel + exact provider/bank assignment gate.
  IF NOT public.merchant_handles_payout(
       v_agent_id, v_row.payout_method, v_row.mobile_money_provider, v_row.bank_name
     ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'provider_not_assigned');
  END IF;

  IF v_row.dispatch_claimed_by IS NOT NULL AND v_row.dispatch_claimed_by <> v_agent_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_claimed');
  END IF;

  IF NOT (v_row.status = ANY (v_open_statuses)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_available', 'status', v_row.status);
  END IF;

  UPDATE public.withdrawal_requests
     SET dispatch_claimed_by = v_agent_id,
         dispatch_claimed_at = now(),
         assigned_cashout_agent_id = COALESCE(assigned_cashout_agent_id,
           (SELECT id FROM public.cashout_agents WHERE agent_id = v_agent_id LIMIT 1)),
         updated_at = now()
   WHERE id = p_withdrawal_id;

  UPDATE public.withdrawal_notification_log
     SET response = 'accepted', claimed_at = now(), updated_at = now()
   WHERE withdrawal_id = p_withdrawal_id AND recipient_id = v_agent_id;

  UPDATE public.withdrawal_notification_log
     SET response = 'superseded', claimed_at = now(), updated_at = now()
   WHERE withdrawal_id = p_withdrawal_id
     AND recipient_id <> v_agent_id
     AND response = 'pending';

  RETURN jsonb_build_object('ok', true, 'withdrawal_id', p_withdrawal_id);
END;
$function$;