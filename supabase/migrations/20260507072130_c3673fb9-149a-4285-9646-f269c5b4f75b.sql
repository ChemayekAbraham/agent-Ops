-- 1. State table
CREATE TABLE IF NOT EXISTS public.ledger_maintenance_state (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id = true), -- single-row guard
  open_until      timestamptz,
  opened_by       uuid,
  opened_at       timestamptz,
  reason          text,
  closed_at       timestamptz,
  closed_by       uuid,
  closed_reason   text
);

INSERT INTO public.ledger_maintenance_state (id, open_until)
VALUES (true, NULL)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.ledger_maintenance_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CFO/manager can read maintenance state" ON public.ledger_maintenance_state;
CREATE POLICY "CFO/manager can read maintenance state"
ON public.ledger_maintenance_state
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'manager'::app_role)
);

-- No INSERT/UPDATE/DELETE policy → only SECURITY DEFINER functions can write.

-- 2. begin / end now write to the table and require role
CREATE OR REPLACE FUNCTION public.begin_ledger_maintenance(
  p_minutes integer DEFAULT 30,
  p_reason  text    DEFAULT 'CFO maintenance'
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_until timestamptz;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cfo'::app_role)
       OR public.has_role(auth.uid(), 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager may open the ledger maintenance window';
  END IF;

  IF p_minutes IS NULL OR p_minutes < 1 THEN p_minutes := 30; END IF;
  IF p_minutes > 240 THEN p_minutes := 240; END IF;
  IF p_reason IS NULL OR length(p_reason) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  v_until := now() + (p_minutes || ' minutes')::interval;

  UPDATE public.ledger_maintenance_state
     SET open_until    = v_until,
         opened_by     = auth.uid(),
         opened_at     = now(),
         reason        = p_reason,
         closed_at     = NULL,
         closed_by     = NULL,
         closed_reason = NULL
   WHERE id = true;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, action, metadata, created_at)
  VALUES ('ledger_maintenance_open', 'ledger_maintenance_state', gen_random_uuid(), 'open',
          jsonb_build_object('reason', p_reason, 'until', v_until, 'minutes', p_minutes,
                             'opened_by', auth.uid()), now());

  RETURN v_until;
END;
$$;

CREATE OR REPLACE FUNCTION public.end_ledger_maintenance(
  p_reason text DEFAULT 'maintenance complete'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'cfo'::app_role)
       OR public.has_role(auth.uid(), 'manager'::app_role)) THEN
    RAISE EXCEPTION 'Only CFO or Manager may close the ledger maintenance window';
  END IF;

  IF p_reason IS NULL OR length(p_reason) < 10 THEN
    RAISE EXCEPTION 'Reason must be at least 10 characters';
  END IF;

  UPDATE public.ledger_maintenance_state
     SET open_until    = NULL,
         closed_at     = now(),
         closed_by     = auth.uid(),
         closed_reason = p_reason
   WHERE id = true;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, action, metadata, created_at)
  VALUES ('ledger_maintenance_close', 'ledger_maintenance_state', gen_random_uuid(), 'close',
          jsonb_build_object('reason', p_reason, 'closed_by', auth.uid()), now());
END;
$$;

-- 3. Guard now reads from the table
CREATE OR REPLACE FUNCTION public.enforce_ledger_rpc_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_flag      text;
  v_bypass    text;
  v_until     timestamptz;
  v_in_window boolean := false;
BEGIN
  -- Maintenance window via table
  SELECT open_until INTO v_until FROM public.ledger_maintenance_state WHERE id = true;
  IF v_until IS NOT NULL AND now() < v_until THEN
    v_in_window := true;
  END IF;

  IF v_in_window THEN
    BEGIN
      INSERT INTO public.audit_logs (action_type, table_name, record_id, action, metadata, created_at)
      VALUES ('ledger_maintenance_write','general_ledger',COALESCE(NEW.id,OLD.id),'write',
              jsonb_build_object('op',TG_OP,'window_until',v_until,
                'amount',COALESCE(NEW.amount,OLD.amount),'category',COALESCE(NEW.category,OLD.category),
                'user_id',COALESCE(NEW.user_id,OLD.user_id)), now());
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Per-txn break-glass
  BEGIN v_bypass := current_setting('ledger.bypass_guard', true);
  EXCEPTION WHEN OTHERS THEN v_bypass := NULL; END;
  IF v_bypass = 'true' THEN
    BEGIN
      INSERT INTO public.audit_logs (action_type, table_name, record_id, action, metadata, created_at)
      VALUES ('ledger_guard_bypass','general_ledger',COALESCE(NEW.id,OLD.id),'bypass',
              jsonb_build_object('op',TG_OP), now());
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Normal: real RPC sets ledger.authorized
  BEGIN v_flag := current_setting('ledger.authorized', true);
  EXCEPTION WHEN OTHERS THEN v_flag := NULL; END;
  IF v_flag IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'general_ledger % blocked: writes must go through create_ledger_transaction RPC.',
      TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

GRANT EXECUTE ON FUNCTION public.begin_ledger_maintenance(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.end_ledger_maintenance(text) TO authenticated;