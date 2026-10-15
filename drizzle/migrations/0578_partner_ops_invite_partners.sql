-- Invited Portfolios panel: who each invited portfolio belongs to.
--
-- One NEW read-only function. No table, column, policy or existing function is changed, and nothing here moves money.
--
--   partner_ops_invite_partners(p_portfolio_ids uuid[])
--       For each requested portfolio: the partner's display name (full name, falling
--       back to their email, then "Unnamed partner"), phone and email, plus whether the
--       portfolio already sits in the self-support pending queue, which the invite
--       pipeline must not show.
--
-- Why: the panel read `profiles` and `funder_pending_portfolios` from the browser with an
-- `in.()` filter over 1,000+ ids. That makes a request URL the API refuses (HTTP 400 past
-- roughly 600 ids) and the old code ignored the failure, so every partner name rendered as
-- "—". The lookup now happens server-side in one posted call.
--
-- Access: Partner Ops, COO, CFO, CEO, manager and super admin only. SECURITY DEFINER,
-- STABLE, search_path = public; granted to authenticated only, revoked from PUBLIC,
-- anon and service_role.

CREATE OR REPLACE FUNCTION public.partner_ops_invite_partners(p_portfolio_ids uuid[])
RETURNS TABLE (
  portfolio_id     uuid,
  partner_name     text,
  partner_phone    text,
  partner_email    text,
  in_pending_queue boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL
     OR NOT (
        public.has_role(v_uid, 'partner_ops'::app_role) OR public.has_role(v_uid, 'coo'::app_role)
        OR public.has_role(v_uid, 'cfo'::app_role) OR public.has_role(v_uid, 'ceo'::app_role)
        OR public.has_role(v_uid, 'manager'::app_role) OR public.has_role(v_uid, 'super_admin'::app_role)
     ) THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only Partner Ops, COO, CFO, CEO, manager and super admin can view the invited partner roster' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    COALESCE(NULLIF(TRIM(pr.full_name), ''), NULLIF(TRIM(pr.email), ''), 'Unnamed partner'),
    NULLIF(TRIM(pr.phone), ''),
    NULLIF(TRIM(pr.email), ''),
    EXISTS (
      SELECT 1 FROM public.funder_pending_portfolios fp
      WHERE fp.portfolio_id = p.id AND fp.status = 'pending'
    )
  FROM unnest(p_portfolio_ids) AS p(id)
  JOIN public.investor_portfolios ip ON ip.id = p.id
  LEFT JOIN public.profiles pr ON pr.id = ip.investor_id;
END;
$function$;

COMMENT ON FUNCTION public.partner_ops_invite_partners(uuid[]) IS
  'Read-only: for each requested portfolio, the partner display name, phone and email, and whether it already sits in the self-support pending queue. Partner Ops, COO, CFO, CEO, manager, super admin.';

REVOKE ALL ON FUNCTION public.partner_ops_invite_partners(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.partner_ops_invite_partners(uuid[]) TO authenticated;