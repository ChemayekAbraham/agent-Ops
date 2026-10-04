-- =====================================================================
-- LEDGER WRITE LOCKDOWN
-- Forces every general_ledger INSERT/UPDATE/DELETE to go through
-- create_ledger_transaction (which sets a per-transaction session flag).
-- Mirrors the pattern used by enforce_wallet_ledger_only on wallets.
-- =====================================================================

-- 1. Guard function -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_ledger_rpc_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_flag text;
  v_bypass text;
BEGIN
  -- Break-glass: explicit per-transaction bypass for emergency CFO use.
  -- Must be set with: SET LOCAL ledger.bypass_guard = 'true';
  -- Visible in postgres logs and audit trail.
  BEGIN
    v_bypass := current_setting('ledger.bypass_guard', true);
  EXCEPTION WHEN OTHERS THEN
    v_bypass := NULL;
  END;

  IF v_bypass = 'true' THEN
    -- Log the bypass to audit_logs for traceability
    BEGIN
      INSERT INTO public.audit_logs (
        action_type, table_name, record_id, reason, metadata, created_at
      ) VALUES (
        'ledger_guard_bypass',
        'general_ledger',
        COALESCE(NEW.id, OLD.id),
        'CFO break-glass: ledger.bypass_guard=true used',
        jsonb_build_object(
          'op', TG_OP,
          'session_user', session_user,
          'current_user', current_user,
          'application_name', current_setting('application_name', true)
        ),
        now()
      );
    EXCEPTION WHEN OTHERS THEN
      -- Never let logging failure block break-glass
      NULL;
    END;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Normal path: require the flag set by create_ledger_transaction
  BEGIN
    v_flag := current_setting('ledger.posted_via_rpc', true);
  EXCEPTION WHEN OTHERS THEN
    v_flag := NULL;
  END;

  IF v_flag IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'general_ledger % blocked: writes must go through create_ledger_transaction RPC. '
      'For emergencies, set LOCAL ledger.bypass_guard = ''true'' inside a transaction (logged to audit_logs).',
      TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.enforce_ledger_rpc_only() IS
'Blocks raw INSERT/UPDATE/DELETE on general_ledger. Only create_ledger_transaction (which sets ledger.posted_via_rpc=true) may write. Break-glass: SET LOCAL ledger.bypass_guard = ''true''; (logged to audit_logs).';

-- 2. Attach trigger -----------------------------------------------------
DROP TRIGGER IF EXISTS trg_enforce_ledger_rpc_only ON public.general_ledger;

CREATE TRIGGER trg_enforce_ledger_rpc_only
BEFORE INSERT OR UPDATE OR DELETE ON public.general_ledger
FOR EACH ROW
EXECUTE FUNCTION public.enforce_ledger_rpc_only();

-- 3. Patch create_ledger_transaction to set the flag --------------------
-- We wrap the existing body by setting the LOCAL flag at the top.
-- SET LOCAL is automatically scoped to the current transaction and cleared
-- on COMMIT/ROLLBACK, so it cannot leak across requests.
CREATE OR REPLACE FUNCTION public.create_ledger_transaction(
  p_entries jsonb,
  p_reference_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn_id uuid := COALESCE(p_reference_id, gen_random_uuid());
  v_entry  jsonb;
  v_cash_in numeric := 0;
  v_cash_out numeric := 0;
BEGIN
  -- Authorize ledger writes for the remainder of this transaction only.
  PERFORM set_config('ledger.posted_via_rpc', 'true', true);

  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) < 2 THEN
    RAISE EXCEPTION 'create_ledger_transaction requires an array of >= 2 entries';
  END IF;

  -- Balance check
  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries) LOOP
    IF (v_entry->>'direction') = 'cash_in' THEN
      v_cash_in := v_cash_in + (v_entry->>'amount')::numeric;
    ELSIF (v_entry->>'direction') = 'cash_out' THEN
      v_cash_out := v_cash_out + (v_entry->>'amount')::numeric;
    ELSE
      RAISE EXCEPTION 'Invalid direction: %', v_entry->>'direction';
    END IF;
  END LOOP;

  IF v_cash_in <> v_cash_out THEN
    RAISE EXCEPTION 'Ledger entries unbalanced: cash_in=% cash_out=%', v_cash_in, v_cash_out;
  END IF;

  -- Insert all legs
  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries) LOOP
    INSERT INTO public.general_ledger (
      user_id,
      amount,
      direction,
      category,
      reference_id,
      recipient_type,
      recipient_id,
      description,
      metadata,
      classification,
      created_at
    ) VALUES (
      NULLIF(v_entry->>'user_id','')::uuid,
      (v_entry->>'amount')::numeric,
      v_entry->>'direction',
      v_entry->>'category',
      v_txn_id,
      NULLIF(v_entry->>'recipient_type',''),
      NULLIF(v_entry->>'recipient_id','')::uuid,
      v_entry->>'description',
      COALESCE(v_entry->'metadata', '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
      COALESCE(v_entry->>'classification', 'production'),
      now()
    );
  END LOOP;

  RETURN v_txn_id;
END;
$$;

COMMENT ON FUNCTION public.create_ledger_transaction(jsonb, uuid, jsonb) IS
'Sole authorized writer to general_ledger. Sets ledger.posted_via_rpc=true (LOCAL) so the enforce_ledger_rpc_only trigger permits the inserts. Validates balanced double-entry before posting.';

-- 4. Sanity: revoke direct DML from public, just in case ----------------
REVOKE INSERT, UPDATE, DELETE ON public.general_ledger FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.general_ledger FROM anon, authenticated;