-- =====================================================================
-- LEDGER MAINTENANCE WINDOW
-- Lets the CFO temporarily unlock the ledger for direct SQL maintenance,
-- with auto-expiry and full audit trail. After the window the guard
-- re-engages automatically.
-- =====================================================================

-- 1. Open the window ---------------------------------------------------
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
  IF p_minutes IS NULL OR p_minutes < 1 THEN p_minutes := 30; END IF;
  IF p_minutes > 240 THEN p_minutes := 240; END IF;  -- hard cap 4 hours
  IF p_reason IS NULL OR length(p_reason) < 10 THEN
    RAISE EXCEPTION 'begin_ledger_maintenance requires a reason of at least 10 characters';
  END IF;

  v_until := now() + (p_minutes || ' minutes')::interval;

  -- Persist across sessions via ALTER DATABASE setting
  EXECUTE format(
    'ALTER DATABASE %I SET app.ledger_maintenance_until = %L',
    current_database(), v_until::text
  );

  INSERT INTO public.audit_logs (
    action_type, table_name, record_id, reason, metadata, created_at
  ) VALUES (
    'ledger_maintenance_open',
    'general_ledger',
    gen_random_uuid(),
    p_reason,
    jsonb_build_object('until', v_until, 'minutes', p_minutes),
    now()
  );

  RETURN v_until;
END;
$$;

-- 2. Close the window --------------------------------------------------
CREATE OR REPLACE FUNCTION public.end_ledger_maintenance(
  p_reason text DEFAULT 'maintenance complete'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_reason IS NULL OR length(p_reason) < 10 THEN
    RAISE EXCEPTION 'end_ledger_maintenance requires a reason of at least 10 characters';
  END IF;

  EXECUTE format(
    'ALTER DATABASE %I SET app.ledger_maintenance_until = %L',
    current_database(), '1970-01-01 00:00:00+00'
  );

  INSERT INTO public.audit_logs (
    action_type, table_name, record_id, reason, metadata, created_at
  ) VALUES (
    'ledger_maintenance_close',
    'general_ledger',
    gen_random_uuid(),
    p_reason,
    '{}'::jsonb,
    now()
  );
END;
$$;

-- 3. Update the guard to honor the maintenance window ------------------
CREATE OR REPLACE FUNCTION public.enforce_ledger_rpc_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_flag        text;
  v_bypass      text;
  v_until_text  text;
  v_until       timestamptz;
  v_in_window   boolean := false;
BEGIN
  -- (a) Maintenance window ------------------------------------------------
  BEGIN
    v_until_text := current_setting('app.ledger_maintenance_until', true);
  EXCEPTION WHEN OTHERS THEN
    v_until_text := NULL;
  END;

  IF v_until_text IS NOT NULL AND v_until_text <> '' THEN
    BEGIN
      v_until := v_until_text::timestamptz;
      IF now() < v_until THEN
        v_in_window := true;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_in_window := false;
    END;
  END IF;

  IF v_in_window THEN
    -- Log every write that happens during the window
    BEGIN
      INSERT INTO public.audit_logs (
        action_type, table_name, record_id, reason, metadata, created_at
      ) VALUES (
        'ledger_maintenance_write',
        'general_ledger',
        COALESCE(NEW.id, OLD.id),
        'write during open maintenance window',
        jsonb_build_object(
          'op', TG_OP,
          'window_until', v_until,
          'session_user', session_user,
          'application_name', current_setting('application_name', true),
          'amount', COALESCE(NEW.amount, OLD.amount),
          'direction', COALESCE(NEW.direction, OLD.direction),
          'category', COALESCE(NEW.category, OLD.category),
          'user_id', COALESCE(NEW.user_id, OLD.user_id)
        ),
        now()
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- (b) Single-transaction break-glass ------------------------------------
  BEGIN
    v_bypass := current_setting('ledger.bypass_guard', true);
  EXCEPTION WHEN OTHERS THEN
    v_bypass := NULL;
  END;

  IF v_bypass = 'true' THEN
    BEGIN
      INSERT INTO public.audit_logs (
        action_type, table_name, record_id, reason, metadata, created_at
      ) VALUES (
        'ledger_guard_bypass',
        'general_ledger',
        COALESCE(NEW.id, OLD.id),
        'CFO break-glass: ledger.bypass_guard=true used',
        jsonb_build_object('op', TG_OP, 'session_user', session_user),
        now()
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- (c) Normal path: require RPC flag ------------------------------------
  BEGIN
    v_flag := current_setting('ledger.posted_via_rpc', true);
  EXCEPTION WHEN OTHERS THEN
    v_flag := NULL;
  END;

  IF v_flag IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'general_ledger % blocked: writes must go through create_ledger_transaction RPC. '
      'Open a maintenance window with begin_ledger_maintenance(minutes, reason) for direct SQL.',
      TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.enforce_ledger_rpc_only() IS
'Blocks raw writes to general_ledger unless: (1) inside a maintenance window opened by begin_ledger_maintenance, (2) explicit per-txn break-glass via SET LOCAL ledger.bypass_guard, or (3) called by create_ledger_transaction.';

COMMENT ON FUNCTION public.begin_ledger_maintenance(integer, text) IS
'Opens a temporary window during which raw SQL can write to general_ledger. Default 30 min, max 240 min. All writes during the window are logged to audit_logs.';

COMMENT ON FUNCTION public.end_ledger_maintenance(text) IS
'Closes the ledger maintenance window immediately, re-engaging the guard.';