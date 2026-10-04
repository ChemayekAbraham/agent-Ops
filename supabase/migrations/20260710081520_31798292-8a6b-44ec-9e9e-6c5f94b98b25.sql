
-- Sub-agent 3-house bonus must require VERIFIED houses, not just submitted ones.
-- Previously subagent_listing_count counted any non-rejected listing, so the
-- recruiting agent got the UGX 10,000 instantly when 3 houses were submitted.

CREATE OR REPLACE FUNCTION public.subagent_listing_count(p_sub_agent_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(count(*), 0)::int
  FROM public.house_listings
  WHERE agent_id = p_sub_agent_id
    AND verified = true
    AND COALESCE(status, '') <> 'rejected';
$function$;

-- Fire the retroactive award when a listing becomes verified (or its status changes).
CREATE OR REPLACE FUNCTION public.award_subagent_bonus_on_listing()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.agent_id IS NOT NULL
     AND NEW.verified = true
     AND COALESCE(NEW.status, '') <> 'rejected' THEN
    PERFORM public.try_award_subagent_registration_bonus(NEW.agent_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_award_subagent_bonus_on_listing ON public.house_listings;
CREATE TRIGGER trg_award_subagent_bonus_on_listing
  AFTER INSERT OR UPDATE OF status, verified ON public.house_listings
  FOR EACH ROW EXECUTE FUNCTION public.award_subagent_bonus_on_listing();
