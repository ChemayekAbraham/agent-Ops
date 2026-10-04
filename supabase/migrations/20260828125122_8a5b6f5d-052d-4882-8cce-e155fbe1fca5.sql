-- The self-support promissory guard must only fence a partner's FIRST capital
-- record. Once a partner already holds any portfolio row, top-ups, compounding,
-- renewals, splits and additional portfolio creation are derived operations and
-- must never be blocked. The insert trigger already had this exemption; the
-- RPC call sites (create_pending_portfolio, funder_create_pending_portfolio)
-- did not, so Partner Ops kept hitting PROMISSORY_SELF_SUPPORT_REQUIRED.
-- Centralising the exemption in the assert keeps all call sites consistent.

CREATE OR REPLACE FUNCTION public.assert_no_promissory_self_support(p_user uuid, p_path text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  IF p_user IS NULL THEN
    RETURN;
  END IF;

  -- Explicit bypass used by the self-support confirmation path itself.
  IF COALESCE(current_setting('psm.self_support_insert', true), '') = 'on' THEN
    RETURN;
  END IF;

  -- Derived operation: the partner already holds capital, so this is not
  -- "first normal portfolio creation".
  IF EXISTS (
    SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = p_user
  ) THEN
    RETURN;
  END IF;

  v := public.promissory_self_support_context(p_user);

  IF COALESCE((v->>'required')::boolean, false) THEN
    RAISE EXCEPTION
      'PROMISSORY_SELF_SUPPORT_REQUIRED: this partner has a pending self-support promissory note covering % tenant plan(s) (UGX %). Fund that note through the self-support flow, or cancel it, before creating their first normal portfolio.',
      v->>'plans', v->>'amount'
      USING ERRCODE = 'check_violation',
            HINT = 'path=' || COALESCE(p_path,'unknown') || '; notes=' || (v->>'note_ids');
  END IF;
END;
$function$;