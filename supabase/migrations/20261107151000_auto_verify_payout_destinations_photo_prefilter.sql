-- auto_verify_waiting_payout_destinations called payout_destination_auto_verdict
-- for every waiting destination. That verdict returns NULL unless the profile
-- has a non-blank national_id_photo_path AND a non-blank selfie_photo_path.
-- The sweep now joins profiles and applies that same guard first.
--
-- A plain AND on the UPDATE was not enough: the planner treated the STABLE
-- verdict as a filter on the base table and never executed the profile join.
-- Putting the verdict in the same UPDATE as a materialized candidate list did
-- the same thing. The guard is therefore its own MATERIALIZED CTE, and the
-- verdict runs only while scanning that CTE. The UPDATE then touches those
-- ids. The verdict arguments, the resubmission exclusion and the returned
-- count are otherwise unchanged.
--
-- Only one overload exists: (p_user_id uuid DEFAULT NULL).
-- Live proacl: {postgres=X/postgres,service_role=X/postgres}.

CREATE OR REPLACE FUNCTION public.auto_verify_waiting_payout_destinations(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  WITH candidates AS MATERIALIZED (
    SELECT d.id,
           d.user_id,
           d.account_name,
           d.national_id,
           d.destination_type,
           d.momo_number,
           d.ownership_code_confirmed_at
    FROM public.payout_destination_verifications d
    JOIN public.profiles p ON p.id = d.user_id
    WHERE d.status = 'waiting'
      AND (p_user_id IS NULL OR d.user_id = p_user_id)
      AND coalesce(d.decision_reason, '') NOT ILIKE 'Resubmitted after rejection%'
      AND nullif(btrim(coalesce(p.national_id_photo_path, '')), '') IS NOT NULL
      AND nullif(btrim(coalesce(p.selfie_photo_path, '')), '') IS NOT NULL
  ),
  chosen AS MATERIALIZED (
    SELECT c.id
    FROM candidates c
    WHERE public.payout_destination_auto_verdict(
            c.user_id, c.account_name, c.national_id,
            c.destination_type, c.momo_number, c.ownership_code_confirmed_at) IS NOT NULL
  ),
  hit AS (
    UPDATE public.payout_destination_verifications d
       SET updated_at = now()
      FROM chosen c
     WHERE d.id = c.id
    RETURNING d.status
  )
  SELECT count(*) FILTER (WHERE status = 'verified') INTO v_count FROM hit;
  RETURN coalesce(v_count, 0);
END;
$function$;

ALTER FUNCTION public.auto_verify_waiting_payout_destinations(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.auto_verify_waiting_payout_destinations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_verify_waiting_payout_destinations(uuid) TO postgres, service_role;
