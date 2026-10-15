-- Invited Portfolios panel: which approved portfolios were actually sent as invites.
--
-- One NEW read-only function. No table, column, policy, or existing function is changed, and nothing here moves money.
--
--   partner_ops_invite_visibility(p_portfolio_ids uuid[])
--       For each requested portfolio: whether it belongs in the invite pipeline
--       (`invited` = it has a completion token OR a partner-portfolio-invite email
--       was logged for its portfolio code), the token's expiry/consumption stamps,
--       and how many times the invite email went out (count, last time, last status).
--
-- Why: the panel previously read `portfolio_completion_tokens` and `email_send_log`
-- directly from the browser, but their RLS only lets partners read their OWN token
-- and nobody reads the send log, so Partner Ops saw every approved invite portfolio
-- silently filtered out ("Approved 0"). The invited-ness decision now happens here,
-- server-side, from both signals; the client only displays it.
--
-- Access: Partner Ops, COO, CFO, CEO, manager and super admin only. SECURITY DEFINER,
-- STABLE, search_path = public; granted to authenticated only, revoked from PUBLIC,
-- anon and service_role.

CREATE OR REPLACE FUNCTION public.partner_ops_invite_visibility(p_portfolio_ids uuid[])
RETURNS TABLE (
  portfolio_id      uuid,
  invited           boolean,
  token_expires_at  timestamptz,
  token_consumed_at timestamptz,
  sent_count        integer,
  last_sent_at      timestamptz,
  last_send_status  text
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
    RAISE EXCEPTION 'NOT_AUTHORISED: only Partner Ops, COO, CFO, CEO, manager and super admin can view invite visibility' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH tok AS (
    SELECT t.portfolio_id, t.expires_at, t.consumed_at
    FROM public.portfolio_completion_tokens t
    WHERE t.portfolio_id = ANY(p_portfolio_ids)
  ),
  sends AS (
    SELECT s.metadata->'template_data'->>'portfolio_code' AS code,
           count(*)::integer AS sent_count,
           max(s.created_at) AS last_sent_at,
           (array_agg(s.status ORDER BY s.created_at DESC))[1] AS last_send_status
    FROM public.email_send_log s
    WHERE s.template_name = 'partner-portfolio-invite'
      AND s.metadata->'template_data'->>'portfolio_code' IS NOT NULL
    GROUP BY 1
  )
  SELECT
    p.id,
    (tok.portfolio_id IS NOT NULL OR sends.sent_count > 0) AS invited,
    tok.expires_at,
    tok.consumed_at,
    COALESCE(sends.sent_count, 0),
    sends.last_sent_at,
    sends.last_send_status
  FROM unnest(p_portfolio_ids) AS p(id)
  JOIN public.investor_portfolios ip ON ip.id = p.id
  LEFT JOIN tok ON tok.portfolio_id = p.id
  LEFT JOIN sends ON sends.code = ip.portfolio_code;
END;
$function$;

COMMENT ON FUNCTION public.partner_ops_invite_visibility(uuid[]) IS
  'Read-only: for each requested portfolio, whether it was sent as an invite (completion token or logged invite email), the token stamps and the invite delivery count/time/status. Partner Ops, COO, CFO, CEO, manager, super admin.';

REVOKE ALL ON FUNCTION public.partner_ops_invite_visibility(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.partner_ops_invite_visibility(uuid[]) TO authenticated;