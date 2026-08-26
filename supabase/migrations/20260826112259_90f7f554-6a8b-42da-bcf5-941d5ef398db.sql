-- 1. Settings (single row) holding the auto-approve switch
CREATE TABLE IF NOT EXISTS public.proxy_commission_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  auto_approve boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

GRANT SELECT ON public.proxy_commission_settings TO authenticated;
GRANT ALL ON public.proxy_commission_settings TO service_role;
ALTER TABLE public.proxy_commission_settings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_proxy_commission_admin(p_user uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = p_user
      AND COALESCE(ur.enabled, true) = true
      AND ur.role = ANY (ARRAY['partner_ops','coo','cfo','ceo','manager','super_admin']::app_role[])
  )
$$;

REVOKE ALL ON FUNCTION public.is_proxy_commission_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_proxy_commission_admin(uuid) TO authenticated, service_role;

CREATE POLICY "Commission admins read settings"
  ON public.proxy_commission_settings FOR SELECT TO authenticated
  USING (public.is_proxy_commission_admin());

INSERT INTO public.proxy_commission_settings (id, auto_approve)
VALUES (true, false)
ON CONFLICT (id) DO NOTHING;

-- 2. Pending commission queue
CREATE TABLE IF NOT EXISTS public.proxy_commission_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('portfolio_creation','portfolio_topup')),
  agent_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  assignment_id uuid,
  base_amount numeric NOT NULL CHECK (base_amount > 0),
  rate numeric NOT NULL CHECK (rate > 0),
  amount numeric NOT NULL CHECK (amount > 0),
  source_table text NOT NULL,
  source_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','rejected')),
  auto_approved boolean NOT NULL DEFAULT false,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  ledger_group_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proxy_commission_queue_status_idx
  ON public.proxy_commission_queue (status, created_at DESC);
CREATE INDEX IF NOT EXISTS proxy_commission_queue_agent_idx
  ON public.proxy_commission_queue (agent_id, created_at DESC);

GRANT SELECT ON public.proxy_commission_queue TO authenticated;
GRANT ALL ON public.proxy_commission_queue TO service_role;
ALTER TABLE public.proxy_commission_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Commission admins read queue"
  ON public.proxy_commission_queue FOR SELECT TO authenticated
  USING (public.is_proxy_commission_admin());

CREATE POLICY "Proxy agents read own commissions"
  ON public.proxy_commission_queue FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_proxy_commission_queue()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_proxy_commission_queue ON public.proxy_commission_queue;
CREATE TRIGGER trg_touch_proxy_commission_queue
  BEFORE UPDATE ON public.proxy_commission_queue
  FOR EACH ROW EXECUTE FUNCTION public.touch_proxy_commission_queue();

-- 3. Payment engine: posts the ledger for one queue row and marks it paid
CREATE OR REPLACE FUNCTION public.pay_proxy_commission_queue_item(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  q public.proxy_commission_queue%ROWTYPE;
  v_group uuid;
  v_label text;
BEGIN
  SELECT * INTO q FROM public.proxy_commission_queue WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','skipped','reason','not_found');
  END IF;
  IF q.status <> 'pending' THEN
    RETURN jsonb_build_object('status','skipped','reason','not_pending','current_status',q.status);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.idempotency_key = q.idempotency_key
      AND g.ledger_scope = 'wallet'
      AND g.direction = 'cash_in'
  ) THEN
    UPDATE public.proxy_commission_queue
       SET status = 'paid', decided_at = COALESCE(decided_at, now())
     WHERE id = q.id;
    RETURN jsonb_build_object('status','skipped','reason','ledger_already_posted');
  END IF;

  v_label := CASE WHEN q.kind = 'portfolio_creation'
                  THEN 'Managed proxy portfolio activation commission ('
                  ELSE 'Managed proxy portfolio top-up commission (' END
             || to_char(q.rate * 100, 'FM999.99') || '%)';

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', q.agent_id, 'amount', q.amount,
        'direction','cash_out', 'category','marketing_expense',
        'source_table', q.source_table, 'source_id', q.source_id,
        'reference_id', q.idempotency_key,
        'description', 'Marketing expense: ' || v_label,
        'ledger_scope','platform',
        'linked_party', q.partner_id::text),
      jsonb_build_object(
        'user_id', q.agent_id, 'amount', q.amount,
        'direction','cash_in', 'category','partner_commission',
        'source_table', q.source_table, 'source_id', q.source_id,
        'reference_id', q.idempotency_key,
        'description', v_label,
        'ledger_scope','wallet', 'recipient_type','user',
        'linked_party', q.partner_id::text)),
    q.idempotency_key);

  UPDATE public.proxy_commission_queue
     SET status = 'paid', ledger_group_id = v_group, decided_at = COALESCE(decided_at, now())
   WHERE id = q.id;

  INSERT INTO public.system_events (event_type, user_id, entity_type, entity_id, metadata)
  VALUES ('wallet_transfer', q.agent_id, 'proxy_commission_queue', q.id,
    jsonb_build_object(
      'kind', q.kind, 'partner_id', q.partner_id, 'proxy_agent_id', q.agent_id,
      'assignment_id', q.assignment_id, 'base_amount', q.base_amount,
      'rate', q.rate, 'commission_amount', q.amount,
      'source_table', q.source_table, 'source_id', q.source_id,
      'auto_approved', q.auto_approved, 'decided_by', q.decided_by,
      'expense_class', 'marketing_expense',
      'idempotency_key', q.idempotency_key, 'ledger_group_id', v_group));

  RETURN jsonb_build_object('status','paid','amount',q.amount,'rate',q.rate,
                            'agent_id',q.agent_id,'ledger_group_id',v_group);
END;
$$;

REVOKE ALL ON FUNCTION public.pay_proxy_commission_queue_item(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pay_proxy_commission_queue_item(uuid) TO service_role;

-- 4. Rewire the earner: file pending unless the auto switch is on
CREATE OR REPLACE FUNCTION public.credit_proxy_agent_portfolio_commission(
  p_partner_id uuid, p_base_amount numeric, p_kind text,
  p_source_table text, p_source_id uuid, p_dedupe_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_proxy_agent_id uuid;
  v_assignment_id uuid;
  v_rate numeric;
  v_amount numeric;
  v_idem text;
  v_auto boolean;
  v_queue_id uuid;
BEGIN
  IF p_partner_id IS NULL OR p_source_id IS NULL OR COALESCE(p_base_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','no_base_amount');
  END IF;

  IF p_kind NOT IN ('portfolio_creation','portfolio_topup') THEN
    RETURN jsonb_build_object('status','skipped','reason','unsupported_kind');
  END IF;

  SELECT a.agent_id, a.id
    INTO v_proxy_agent_id, v_assignment_id
  FROM public.proxy_agent_assignments a
  WHERE a.beneficiary_id = p_partner_id
    AND a.is_active = true
    AND COALESCE(a.is_managed_account, false) = true
    AND COALESCE(a.approval_status, 'pending') = 'approved'
    AND a.agent_id IS NOT NULL
    AND a.agent_id <> p_partner_id
    AND (a.expires_at IS NULL OR a.expires_at > now())
  ORDER BY a.approved_at DESC NULLS LAST, a.created_at DESC NULLS LAST, a.id
  LIMIT 1;

  IF v_proxy_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_active_managed_proxy');
  END IF;

  v_rate := CASE p_kind
    WHEN 'portfolio_creation' THEN 0.02
    WHEN 'portfolio_topup' THEN 0.01
    ELSE 0 END;

  v_amount := round(p_base_amount * v_rate);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','amount_rounds_to_zero');
  END IF;

  v_idem := 'proxy_agent_portfolio_commission:' || p_kind || ':' || p_source_table || ':'
            || COALESCE(p_dedupe_key, p_source_id::text);

  IF EXISTS (SELECT 1 FROM public.proxy_commission_queue q WHERE q.idempotency_key = v_idem) THEN
    RETURN jsonb_build_object('status','skipped','reason','duplicate_source');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.idempotency_key = v_idem
      AND g.ledger_scope = 'wallet'
      AND g.direction = 'cash_in'
  ) THEN
    RETURN jsonb_build_object('status','skipped','reason','duplicate_source');
  END IF;

  SELECT COALESCE(s.auto_approve, false) INTO v_auto
  FROM public.proxy_commission_settings s WHERE s.id = true;

  INSERT INTO public.proxy_commission_queue
    (kind, agent_id, partner_id, assignment_id, base_amount, rate, amount,
     source_table, source_id, idempotency_key, status, auto_approved)
  VALUES (p_kind, v_proxy_agent_id, p_partner_id, v_assignment_id, p_base_amount, v_rate, v_amount,
          p_source_table, p_source_id::text, v_idem, 'pending', COALESCE(v_auto, false))
  RETURNING id INTO v_queue_id;

  IF COALESCE(v_auto, false) THEN
    RETURN public.pay_proxy_commission_queue_item(v_queue_id)
           || jsonb_build_object('queue_id', v_queue_id, 'auto_approved', true);
  END IF;

  RETURN jsonb_build_object('status','queued','queue_id',v_queue_id,
                            'amount',v_amount,'rate',v_rate,
                            'agent_id',v_proxy_agent_id,'assignment_id',v_assignment_id);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_proxy_agent_portfolio_commission(uuid, numeric, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credit_proxy_agent_portfolio_commission(uuid, numeric, text, text, uuid, text) TO service_role;

-- 5. Partner Ops decisions
CREATE OR REPLACE FUNCTION public.approve_proxy_commission(p_id uuid, p_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_res jsonb;
BEGIN
  IF NOT public.is_proxy_commission_admin() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only Partner Operations may approve proxy commissions';
  END IF;

  UPDATE public.proxy_commission_queue
     SET decided_by = auth.uid(), decided_at = now(), decision_note = NULLIF(btrim(p_note), '')
   WHERE id = p_id AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','skipped','reason','not_pending');
  END IF;

  v_res := public.pay_proxy_commission_queue_item(p_id);
  RETURN v_res;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_proxy_commission(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT public.is_proxy_commission_admin() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only Partner Operations may reject proxy commissions';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'A rejection requires a written reason of at least 10 characters.';
  END IF;

  UPDATE public.proxy_commission_queue
     SET status = 'rejected', decided_by = auth.uid(), decided_at = now(),
         decision_note = btrim(p_reason)
   WHERE id = p_id AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','skipped','reason','not_pending');
  END IF;

  RETURN jsonb_build_object('status','rejected','id',p_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_proxy_commission_auto_approve(p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT public.is_proxy_commission_admin() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only Partner Operations may change this setting';
  END IF;

  INSERT INTO public.proxy_commission_settings (id, auto_approve, updated_at, updated_by)
  VALUES (true, COALESCE(p_enabled, false), now(), auth.uid())
  ON CONFLICT (id) DO UPDATE
    SET auto_approve = EXCLUDED.auto_approve,
        updated_at = now(),
        updated_by = auth.uid();

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (auth.uid(), 'update', 'proxy_commission_settings', NULL,
          'Proxy commission automatic approval switch changed by Partner Operations',
          jsonb_build_object('auto_approve', COALESCE(p_enabled, false)));

  RETURN jsonb_build_object('status','ok','auto_approve', COALESCE(p_enabled, false));
END;
$$;

-- 6. Read model for the UI (no N+1)
CREATE OR REPLACE FUNCTION public.get_proxy_commission_queue(p_status text DEFAULT 'pending', p_limit int DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_rows jsonb; v_totals jsonb; v_auto boolean;
BEGIN
  IF NOT public.is_proxy_commission_admin() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED';
  END IF;

  SELECT COALESCE(s.auto_approve, false) INTO v_auto
  FROM public.proxy_commission_settings s WHERE s.id = true;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'id', q.id, 'kind', q.kind, 'status', q.status,
      'agent_id', q.agent_id, 'agent_name', ap.full_name,
      'partner_id', q.partner_id, 'partner_name', pp.full_name,
      'base_amount', q.base_amount, 'rate', q.rate, 'amount', q.amount,
      'source_table', q.source_table, 'source_id', q.source_id,
      'auto_approved', q.auto_approved,
      'decided_by', q.decided_by, 'decided_by_name', dp.full_name,
      'decided_at', q.decided_at, 'decision_note', q.decision_note,
      'ledger_group_id', q.ledger_group_id,
      'created_at', q.created_at
    ) AS x
    FROM public.proxy_commission_queue q
    LEFT JOIN public.profiles ap ON ap.id = q.agent_id
    LEFT JOIN public.profiles pp ON pp.id = q.partner_id
    LEFT JOIN public.profiles dp ON dp.id = q.decided_by
    WHERE (p_status IS NULL OR p_status = 'all' OR q.status = p_status)
    ORDER BY q.created_at DESC
    LIMIT GREATEST(COALESCE(p_limit, 200), 1)
  ) s2;

  SELECT jsonb_build_object(
    'pending_count', COUNT(*) FILTER (WHERE status = 'pending'),
    'pending_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0),
    'paid_count', COUNT(*) FILTER (WHERE status = 'paid'),
    'paid_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0),
    'rejected_count', COUNT(*) FILTER (WHERE status = 'rejected'),
    'creation_pending_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'pending' AND kind = 'portfolio_creation'), 0),
    'topup_pending_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'pending' AND kind = 'portfolio_topup'), 0)
  ) INTO v_totals
  FROM public.proxy_commission_queue;

  RETURN jsonb_build_object('auto_approve', COALESCE(v_auto, false), 'totals', v_totals, 'rows', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_proxy_commission(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_proxy_commission(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_proxy_commission_auto_approve(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_proxy_commission_queue(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_proxy_commission(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_proxy_commission(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_proxy_commission_auto_approve(boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_proxy_commission_queue(text, int) TO authenticated, service_role;