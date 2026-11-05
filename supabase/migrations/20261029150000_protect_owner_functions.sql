-- Protected functions: the owner's controls cannot be rewritten without the owner knowing, and are put back when they are.
--
-- WHAT IT DOES
--   * protected_functions keeps the exact definition of each protected function.
--   * An event trigger watches every CREATE / ALTER / DROP FUNCTION. If the function is protected and the change is not unlocked, the change is UNDONE in
--     the same transaction (the saved definition is put back; an extra overload is removed; a dropped function is re-created) and the attempt is logged in
--     protected_function_changes and emailed to joshwanda17@gmail.com only (edge function protected-function-alert).
--   * A check every 10 minutes (pg_cron) catches what the trigger cannot see (for example the trigger itself being dropped or disabled, or the catalog being
--     edited directly): any protected function whose definition no longer matches is put back and emailed.
--   * An authorised change is made by setting the unlock token in the SAME transaction: select set_config('welile.fn_unlock', '<your token>', true);
--     The change is then kept, becomes the new saved definition, and is still logged and emailed (outcome 'allowed_with_unlock').
--   * The token is chosen by the owner and only its hash is stored. Until it is set, EVERY change to a protected function is undone.
--     Set it once, right after applying this: select public.protect_set_unlock_token('<a long phrase only you know>');
--
-- WHAT IT CANNOT DO: a database superuser can still drop the event trigger or the tables. The 10-minute check notices and emails, but it cannot stop it.
-- Grants and revokes on a function are not covered; only its definition is.
-- Roll back with 20261029150000_protect_owner_functions.rollback.sql.

CREATE TABLE IF NOT EXISTS public.protected_functions (
  identity       text PRIMARY KEY,
  schema_name    text NOT NULL,
  func_name      text NOT NULL,
  definition     text NOT NULL,
  definition_md5 text NOT NULL,
  protected_at   timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.protected_function_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  identity    text,
  command     text,
  outcome     text NOT NULL,
  db_user     text,
  session_usr text,
  app_name    text,
  client_addr text,
  jwt_sub     text,
  jwt_role    text,
  old_md5     text,
  new_md5     text,
  detail      text,
  notified    boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.protected_function_settings (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  unlock_hash text,
  set_at      timestamptz
);
INSERT INTO public.protected_function_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

ALTER TABLE public.protected_functions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.protected_function_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.protected_function_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.protected_functions, public.protected_function_changes, public.protected_function_settings FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._pf_identity(p_oid oid)
 RETURNS text LANGUAGE sql STABLE SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT n.nspname || '.' || p.proname || '(' || replace(oidvectortypes(p.proargtypes), ' ', '') || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = p_oid;
$function$;

CREATE OR REPLACE FUNCTION public._pf_unlocked()
 RETURNS boolean LANGUAGE plpgsql STABLE SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_hash text; v_tok text;
BEGIN
  SELECT unlock_hash INTO v_hash FROM public.protected_function_settings WHERE id;
  v_tok := current_setting('welile.fn_unlock', true);
  RETURN v_hash IS NOT NULL AND v_tok IS NOT NULL AND v_tok <> ''
         AND encode(sha256(convert_to(v_tok, 'UTF8')), 'hex') = v_hash;
END;
$function$;

CREATE OR REPLACE FUNCTION public._pf_log(p_identity text, p_command text, p_outcome text, p_old_md5 text, p_new_md5 text, p_detail text DEFAULT NULL)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_id uuid; v_claims jsonb; v_addr text;
BEGIN
  BEGIN v_claims := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb; EXCEPTION WHEN others THEN v_claims := '{}'::jsonb; END;
  BEGIN v_addr := inet_client_addr()::text; EXCEPTION WHEN others THEN v_addr := NULL; END;
  INSERT INTO public.protected_function_changes
    (identity, command, outcome, db_user, session_usr, app_name, client_addr, jwt_sub, jwt_role, old_md5, new_md5, detail)
  VALUES
    (p_identity, p_command, p_outcome, current_user, session_user, nullif(current_setting('application_name', true), ''), v_addr,
     v_claims ->> 'sub', v_claims ->> 'role', p_old_md5, p_new_md5, p_detail)
  RETURNING id INTO v_id;

  -- Email, best effort: a failure here must never stop the change being undone.
  BEGIN
    PERFORM net.http_post(
      url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/protected-function-alert',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5cnpzaHdsZW50cXZrdGNrc2VtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4OTI3MTQsImV4cCI6MjEwNzQ2ODcxNH0.8oMYC39wCMHtVlevN1D8rQnIZgtcwJVpG6z3QnTXnAs'),
      body := jsonb_build_object('change_id', v_id));
  EXCEPTION WHEN others THEN NULL;
  END;
  RETURN v_id;
END;
$function$;

-- Put a saved definition back (the guard switch stops this from being treated as a new change).
CREATE OR REPLACE FUNCTION public._pf_restore(p_definition text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  PERFORM set_config('welile.pf_reverting', 'on', true);
  EXECUTE p_definition;
  PERFORM set_config('welile.pf_reverting', 'off', true);
EXCEPTION WHEN others THEN
  PERFORM set_config('welile.pf_reverting', 'off', true);
  RAISE;
END;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- Event trigger: a protected function was created, replaced or altered.
CREATE OR REPLACE FUNCTION public.protected_functions_guard()
 RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  r record; v_id text; v_schema text; v_name text; v_base record; v_def text; v_md5 text;
BEGIN
  IF coalesce(current_setting('welile.pf_reverting', true), '') = 'on' THEN RETURN; END IF;
  FOR r IN SELECT objid, command_tag FROM pg_event_trigger_ddl_commands() WHERE object_type = 'function' LOOP
    SELECT n.nspname, p.proname INTO v_schema, v_name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.oid = r.objid;
    IF v_name IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.protected_functions f WHERE f.schema_name = v_schema AND f.func_name = v_name) THEN CONTINUE; END IF;

    v_id  := public._pf_identity(r.objid);
    v_def := pg_get_functiondef(r.objid);
    v_md5 := md5(v_def);
    SELECT * INTO v_base FROM public.protected_functions f WHERE f.identity = v_id;
    IF v_base.identity IS NOT NULL AND v_base.definition_md5 = v_md5 THEN CONTINUE; END IF;   -- nothing about the definition changed

    IF public._pf_unlocked() THEN
      INSERT INTO public.protected_functions (identity, schema_name, func_name, definition, definition_md5)
      VALUES (v_id, v_schema, v_name, v_def, v_md5)
      ON CONFLICT (identity) DO UPDATE SET definition = excluded.definition, definition_md5 = excluded.definition_md5, updated_at = now();
      PERFORM public._pf_log(v_id, r.command_tag, 'allowed_with_unlock', v_base.definition_md5, v_md5);
    ELSIF v_base.identity IS NULL THEN
      PERFORM public._pf_log(v_id, r.command_tag, 'new_overload_removed', NULL, v_md5);
      PERFORM set_config('welile.pf_reverting', 'on', true);
      EXECUTE format('DROP FUNCTION %s', r.objid::regprocedure);
      PERFORM set_config('welile.pf_reverting', 'off', true);
    ELSE
      PERFORM public._pf_log(v_id, r.command_tag, 'reverted', v_base.definition_md5, v_md5);
      PERFORM public._pf_restore(v_base.definition);
    END IF;
  END LOOP;
END;
$function$;

-- Event trigger: a protected function was dropped.
CREATE OR REPLACE FUNCTION public.protected_functions_drop_guard()
 RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE r record; v_base record;
BEGIN
  IF coalesce(current_setting('welile.pf_reverting', true), '') = 'on' THEN RETURN; END IF;
  FOR r IN SELECT object_identity FROM pg_event_trigger_dropped_objects() WHERE object_type = 'function' LOOP
    SELECT * INTO v_base FROM public.protected_functions f WHERE replace(f.identity, ' ', '') = replace(r.object_identity, ' ', '');
    IF v_base.identity IS NULL THEN CONTINUE; END IF;
    IF public._pf_unlocked() THEN
      DELETE FROM public.protected_functions WHERE identity = v_base.identity;
      PERFORM public._pf_log(v_base.identity, 'DROP FUNCTION', 'dropped_with_unlock', v_base.definition_md5, NULL);
    ELSE
      PERFORM public._pf_log(v_base.identity, 'DROP FUNCTION', 'recreated', v_base.definition_md5, NULL);
      PERFORM public._pf_restore(v_base.definition);
    END IF;
  END LOOP;
END;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- The 10-minute check: anything the event triggers could not see.
CREATE OR REPLACE FUNCTION public.protected_functions_check()
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE r record; v_oid oid; v_found boolean; v_n integer := 0;
BEGIN
  FOR r IN SELECT * FROM public.protected_functions LOOP
    v_oid := NULL;
    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = r.schema_name AND p.proname = r.func_name AND public._pf_identity(p.oid) = r.identity;
    IF v_oid IS NULL THEN
      PERFORM public._pf_log(r.identity, 'check', 'recreated', r.definition_md5, NULL, 'The function was missing at the periodic check.');
      PERFORM public._pf_restore(r.definition); v_n := v_n + 1;
    ELSIF md5(pg_get_functiondef(v_oid)) <> r.definition_md5 THEN
      PERFORM public._pf_log(r.identity, 'check', 'drift_reverted', r.definition_md5, md5(pg_get_functiondef(v_oid)), 'The definition did not match at the periodic check.');
      PERFORM public._pf_restore(r.definition); v_n := v_n + 1;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM (VALUES ('zz_protected_functions_guard', 'ddl_command_end'), ('zz_protected_functions_drop_guard', 'sql_drop')) t(nm, ev) LOOP
    SELECT EXISTS (SELECT 1 FROM pg_event_trigger e WHERE e.evtname = r.nm AND e.evtenabled = 'O') INTO v_found;
    IF NOT v_found THEN
      PERFORM public._pf_log(r.nm, 'check', 'guard_restored', NULL, NULL, 'The event trigger was missing or disabled at the periodic check.');
      EXECUTE format('DROP EVENT TRIGGER IF EXISTS %I', r.nm);
      IF r.ev = 'ddl_command_end' THEN
        EXECUTE format('CREATE EVENT TRIGGER %I ON ddl_command_end WHEN TAG IN (''CREATE FUNCTION'', ''ALTER FUNCTION'') EXECUTE FUNCTION public.protected_functions_guard()', r.nm);
      ELSE
        EXECUTE format('CREATE EVENT TRIGGER %I ON sql_drop EXECUTE FUNCTION public.protected_functions_drop_guard()', r.nm);
      END IF;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- Managing the list and the token. Not callable from the app: only a database session (SQL editor) can run these.
CREATE OR REPLACE FUNCTION public.protect_set_unlock_token(p_new text, p_old text DEFAULT NULL)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_hash text;
BEGIN
  IF p_new IS NULL OR length(p_new) < 12 THEN RAISE EXCEPTION 'Use a longer token (at least 12 characters).'; END IF;
  SELECT unlock_hash INTO v_hash FROM public.protected_function_settings WHERE id;
  IF v_hash IS NOT NULL AND (p_old IS NULL OR encode(sha256(convert_to(p_old, 'UTF8')), 'hex') <> v_hash) THEN
    PERFORM public._pf_log('unlock token', 'protect_set_unlock_token', 'token_change_refused', NULL, NULL);
    RAISE EXCEPTION 'The current token is needed to change it.';
  END IF;
  UPDATE public.protected_function_settings SET unlock_hash = encode(sha256(convert_to(p_new, 'UTF8')), 'hex'), set_at = now() WHERE id;
  PERFORM public._pf_log('unlock token', 'protect_set_unlock_token', CASE WHEN v_hash IS NULL THEN 'token_set' ELSE 'token_changed' END, NULL, NULL);
  RETURN 'Token saved. To change a protected function, run in the same transaction: select set_config(''welile.fn_unlock'', ''<your token>'', true);';
END;
$function$;

-- Adds every overload of public.<name> to the list, with its definition as it is now. Allowed before a token exists, or with the unlock set.
CREATE OR REPLACE FUNCTION public.protect_function(p_name text)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE r record; v_n integer := 0; v_has_token boolean;
BEGIN
  SELECT unlock_hash IS NOT NULL INTO v_has_token FROM public.protected_function_settings WHERE id;
  IF v_has_token AND NOT public._pf_unlocked() THEN
    PERFORM public._pf_log(p_name, 'protect_function', 'refused_locked', NULL, NULL);
    RAISE EXCEPTION 'Unlock first (set welile.fn_unlock in this transaction).';
  END IF;
  FOR r IN SELECT p.oid, n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = p_name AND p.prokind = 'f' LOOP
    INSERT INTO public.protected_functions (identity, schema_name, func_name, definition, definition_md5)
    VALUES (public._pf_identity(r.oid), r.nspname, r.proname, pg_get_functiondef(r.oid), md5(pg_get_functiondef(r.oid)))
    ON CONFLICT (identity) DO UPDATE SET definition = excluded.definition, definition_md5 = excluded.definition_md5, updated_at = now();
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unprotect_function(p_name text)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_n integer;
BEGIN
  IF NOT public._pf_unlocked() THEN
    PERFORM public._pf_log(p_name, 'unprotect_function', 'refused_locked', NULL, NULL);
    RAISE EXCEPTION 'Unlock first (set welile.fn_unlock in this transaction).';
  END IF;
  DELETE FROM public.protected_functions WHERE func_name = p_name AND schema_name = 'public';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM public._pf_log(p_name, 'unprotect_function', 'unprotected', NULL, NULL);
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public._pf_identity(oid), public._pf_unlocked(), public._pf_log(text, text, text, text, text, text), public._pf_restore(text),
  public.protected_functions_guard(), public.protected_functions_drop_guard(), public.protected_functions_check(),
  public.protect_set_unlock_token(text, text), public.protect_function(text), public.unprotect_function(text)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- Turn it on: the owner's landlord-payout controls first. Names that do not exist are skipped. Add more with: select public.protect_function('name');
SELECT public.protect_function(n) FROM unnest(ARRAY[
  'get_landlord_payout_renewals', 'get_landlord_payout_block_queue', 'get_landlord_payout_agent_rates', 'get_landlord_payout_budget',
  'set_landlord_payout_budget', 'set_landlord_payout_budget_unchecked', 'set_landlord_payout_block_exemption', 'set_landlord_payout_block_exemption_unchecked',
  'allow_landlord_payouts_with_exception', 'allow_landlord_payouts_with_exception_unchecked', 'reject_landlord_payouts', 'guard_landlord_payouts_switch',
  '_is_landlord_payout_owner', 'landlord_payout_queue_blocked', 'landlord_payouts_blocked_from_queue', 'landlord_payout_allowed_today',
  'landlord_payout_goal_allowed', 'landlord_payout_goal_started_at', 'check_landlord_payout_eligibility', 'enforce_landlord_payout_eligibility',
  'get_cto_controlled_plan_collections'
]) AS n;

DROP EVENT TRIGGER IF EXISTS zz_protected_functions_guard;
CREATE EVENT TRIGGER zz_protected_functions_guard ON ddl_command_end
  WHEN TAG IN ('CREATE FUNCTION', 'ALTER FUNCTION') EXECUTE FUNCTION public.protected_functions_guard();
DROP EVENT TRIGGER IF EXISTS zz_protected_functions_drop_guard;
CREATE EVENT TRIGGER zz_protected_functions_drop_guard ON sql_drop EXECUTE FUNCTION public.protected_functions_drop_guard();

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'protected-functions-check';
SELECT cron.schedule('protected-functions-check', '*/10 * * * *', 'select public.protected_functions_check()');
