-- Agent activity for the pure-partner payout exemption is decided ONLY by
-- recorded agent collections. Holding an agent role (or an old rent request)
-- does not make someone an operating agent: every user can reach the agent
-- dashboard, so the role flag is not evidence of activity.
--
-- Scope: this one predicate. Every other payout control is untouched.
CREATE OR REPLACE FUNCTION public.user_is_pure_partner(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL
     AND public.user_is_funder_with_portfolio(p_user_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.agent_collections c WHERE c.agent_id = p_user_id
     );
$function$;

COMMENT ON FUNCTION public.user_is_pure_partner(uuid) IS
  'True when the user holds at least one live portfolio and has NO recorded agent collections. Agent roles and rent requests are deliberately not consulted: role alone is not agent activity.';
