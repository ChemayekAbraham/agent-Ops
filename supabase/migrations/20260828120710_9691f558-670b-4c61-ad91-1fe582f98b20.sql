-- 1. Narrow the assert: only block while the note is genuinely pending with unfunded plans.
CREATE OR REPLACE FUNCTION public.promissory_self_support_context(p_user uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'required', COUNT(DISTINCT n.id) > 0,
    'plans', COUNT(i.id),
    'amount', COALESCE(SUM(i.amount), 0),
    'note_ids', COALESCE(jsonb_agg(DISTINCT n.id), '[]'::jsonb)
  )
  FROM public.promissory_notes n
  JOIN public.promissory_note_plan_intents i
    ON i.note_id = n.id
   AND i.status = 'reserved'
  WHERE p_user IS NOT NULL
    AND n.partner_user_id = p_user
    AND n.support_mode = 'self_support'
    AND n.status = 'pending';
$$;

CREATE OR REPLACE FUNCTION public.assert_no_promissory_self_support(p_user uuid, p_path text)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v jsonb := public.promissory_self_support_context(p_user);
BEGIN
  IF COALESCE((v->>'required')::boolean, false) THEN
    RAISE EXCEPTION
      'PROMISSORY_SELF_SUPPORT_REQUIRED: this partner has a pending self-support promissory note covering % tenant plan(s) (UGX %). Fund that note through the self-support flow, or cancel it, before creating their first normal portfolio.',
      v->>'plans', v->>'amount'
      USING ERRCODE = 'check_violation',
            HINT = 'path=' || COALESCE(p_path,'unknown') || '; notes=' || (v->>'note_ids');
  END IF;
END;
$$;

-- 2. Narrow the trigger: derived portfolio rows (renewal, principal split, compounding,
--    top-up application) must never be blocked. Only a partner's very first portfolio
--    row is routed through the self-support rule.
CREATE OR REPLACE FUNCTION public.guard_promissory_portfolio_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.investor_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- explicit bypass used by the self-support confirmation path
  IF COALESCE(current_setting('psm.self_support_insert', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  -- derived rows: the partner already holds capital, so this is a renewal / split /
  -- compound / top-up, not "normal portfolio creation".
  IF EXISTS (
    SELECT 1 FROM public.investor_portfolios ip
    WHERE ip.investor_id = NEW.investor_id
      AND ip.id <> NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.assert_no_promissory_self_support(NEW.investor_id, 'investor_portfolios_trigger');
  RETURN NEW;
END;
$$;