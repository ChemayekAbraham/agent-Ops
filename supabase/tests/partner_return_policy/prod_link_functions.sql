-- Production's profile-driven note linking, VERBATIM (pg_get_functiondef read with SELECT from byrzshwlentqvktcksem on
-- 2026-11-07), plus the two profile triggers (pg_get_triggerdef). LOCAL TEST CLUSTER ONLY.
--   md5(pg_get_functiondef):
--     link_promissory_notes_for_user(p_user uuid)   9676d0b3179d3cf2caca650a3fac2883
--     link_proxy_records_on_profile()               cb81fbf93e0de2dad377985c1b5bf41b
--     trg_link_promissory_notes_on_profile()        0029eb5d611c54d0819f2e1a17d57e75
--   ACL in production: {postgres=X/postgres,service_role=X/postgres} for all three (owner postgres, SECURITY DEFINER).
-- Load after race_stub.sql + race_stub_phase2.sql (+ race_stub_phase4.sql). The stub prerequisites first: profiles needs
-- referrer_id (trg_link_proxy_records_on_profile fires on UPDATE OF phone, referrer_id) and proxy_partner_invites
-- (link_proxy_records_on_profile updates it when NEW.referrer_id is set); system_events needs related_entity_type,
-- related_entity_id and description (race_stub_phase2.sql adds them).
-- Keep this file LF-only: a CR inside a body changes the md5.
SET client_min_messages = warning;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS referrer_id uuid;
CREATE TABLE IF NOT EXISTS public.proxy_partner_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), proxy_agent_id uuid, invitee_phone text,
  signed_up_user_id uuid, signed_up_at timestamptz);

CREATE OR REPLACE FUNCTION public.link_promissory_notes_for_user(p_user uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_phone9 text;
  v_email text;
  v_linked integer := 0;
BEGIN
  IF p_user IS NULL THEN RETURN 0; END IF;

  SELECT right(regexp_replace(COALESCE(p.phone,''), '\D', '', 'g'), 9),
         lower(NULLIF(btrim(COALESCE(p.email,'')), ''))
    INTO v_phone9, v_email
  FROM public.profiles p WHERE p.id = p_user;

  IF COALESCE(length(v_phone9),0) < 9 AND v_email IS NULL THEN RETURN 0; END IF;

  WITH linked AS (
    UPDATE public.promissory_notes n
       SET partner_user_id = p_user, updated_at = now()
     WHERE n.partner_user_id IS NULL
       AND n.status IN ('pending','activated')
       AND (
         (COALESCE(length(v_phone9),0) = 9 AND (
            right(regexp_replace(COALESCE(n.whatsapp_number,''), '\D', '', 'g'), 9) = v_phone9
            OR right(regexp_replace(COALESCE(n.phone_number,''), '\D', '', 'g'), 9) = v_phone9))
         OR (v_email IS NOT NULL AND lower(btrim(COALESCE(n.email,''))) = v_email)
       )
    RETURNING n.id, n.amount, n.agent_id
  )
  INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
  SELECT 'promissory.partner.auto_linked', p_user, 'promissory_notes', l.id,
         'Promissory note auto-linked to the partner account on registration',
         jsonb_build_object('amount', l.amount, 'agent_id', l.agent_id, 'match', 'phone_or_email')
  FROM linked l;

  GET DIAGNOSTICS v_linked = ROW_COUNT;
  RETURN v_linked;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.link_proxy_records_on_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_last9 text := normalize_phone_last9(NEW.phone);
BEGIN
  IF v_last9 IS NULL THEN RETURN NEW; END IF;

  UPDATE promissory_notes n
     SET partner_user_id = NEW.id, updated_at = now()
   WHERE n.partner_user_id IS NULL
     AND v_last9 IN (
       normalize_phone_last9(n.whatsapp_number),
       normalize_phone_last9(COALESCE(n.phone_number,''))
     );

  IF NEW.referrer_id IS NOT NULL THEN
    UPDATE proxy_partner_invites i
       SET signed_up_user_id = NEW.id,
           signed_up_at = COALESCE(i.signed_up_at, now())
     WHERE i.signed_up_user_id IS NULL
       AND i.proxy_agent_id = NEW.referrer_id
       AND normalize_phone_last9(COALESCE(i.invitee_phone,'')) = v_last9;
  END IF;

  RETURN NEW;
END; $function$
;

CREATE OR REPLACE FUNCTION public.trg_link_promissory_notes_on_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM public.link_promissory_notes_for_user(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'link_promissory_notes_for_user failed for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$function$
;

REVOKE ALL ON FUNCTION public.link_promissory_notes_for_user(uuid), public.link_proxy_records_on_profile(),
  public.trg_link_promissory_notes_on_profile() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_promissory_notes_for_user(uuid), public.link_proxy_records_on_profile(),
  public.trg_link_promissory_notes_on_profile() TO service_role;

DROP TRIGGER IF EXISTS trg_link_proxy_records_on_profile ON public.profiles;
CREATE TRIGGER trg_link_proxy_records_on_profile AFTER INSERT OR UPDATE OF phone, referrer_id ON public.profiles FOR EACH ROW EXECUTE FUNCTION link_proxy_records_on_profile();
DROP TRIGGER IF EXISTS trg_profiles_link_promissory_notes ON public.profiles;
CREATE TRIGGER trg_profiles_link_promissory_notes AFTER INSERT OR UPDATE OF phone, email ON public.profiles FOR EACH ROW EXECUTE FUNCTION trg_link_promissory_notes_on_profile();

-- Byte check against production.
DO $chk$
DECLARE r record; v text := '';
BEGIN
  FOR r IN SELECT * FROM (VALUES ('public.link_promissory_notes_for_user(uuid)', '9676d0b3179d3cf2caca650a3fac2883'),
                                 ('public.link_proxy_records_on_profile()', 'cb81fbf93e0de2dad377985c1b5bf41b'),
                                 ('public.trg_link_promissory_notes_on_profile()', '0029eb5d611c54d0819f2e1a17d57e75')) x(fn, m)
  LOOP
    IF md5(pg_get_functiondef(r.fn::regprocedure)) <> r.m THEN v := v || ' ' || r.fn; END IF;
  END LOOP;
  IF v <> '' THEN RAISE EXCEPTION 'prod_link_functions.sql: md5 differs from production:%', v; END IF;
END $chk$;
SELECT 'prod link functions ready';
