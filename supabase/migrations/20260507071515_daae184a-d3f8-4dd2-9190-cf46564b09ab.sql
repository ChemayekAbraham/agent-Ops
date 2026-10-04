-- 1. Drop the bad overload I introduced
DROP FUNCTION IF EXISTS public.create_ledger_transaction(jsonb, uuid, jsonb);

-- 2. Patch the guard to honor the real RPC's session flag
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
  -- (a) Maintenance window
  BEGIN
    v_until_text := current_setting('app.ledger_maintenance_until', true);
  EXCEPTION WHEN OTHERS THEN v_until_text := NULL;
  END;
  IF v_until_text IS NOT NULL AND v_until_text <> '' THEN
    BEGIN
      v_until := v_until_text::timestamptz;
      IF now() < v_until THEN v_in_window := true; END IF;
    EXCEPTION WHEN OTHERS THEN v_in_window := false;
    END;
  END IF;
  IF v_in_window THEN
    BEGIN
      INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata, created_at)
      VALUES ('ledger_maintenance_write','general_ledger',COALESCE(NEW.id,OLD.id),
              'write during open maintenance window',
              jsonb_build_object('op',TG_OP,'window_until',v_until,'session_user',session_user,
                'amount',COALESCE(NEW.amount,OLD.amount),'category',COALESCE(NEW.category,OLD.category),
                'user_id',COALESCE(NEW.user_id,OLD.user_id)), now());
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- (b) Break-glass
  BEGIN v_bypass := current_setting('ledger.bypass_guard', true);
  EXCEPTION WHEN OTHERS THEN v_bypass := NULL; END;
  IF v_bypass = 'true' THEN
    BEGIN
      INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata, created_at)
      VALUES ('ledger_guard_bypass','general_ledger',COALESCE(NEW.id,OLD.id),
              'CFO break-glass: ledger.bypass_guard=true used',
              jsonb_build_object('op',TG_OP,'session_user',session_user), now());
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- (c) Normal: real RPC sets ledger.authorized='true'
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