CREATE OR REPLACE FUNCTION public.finops_post_merchant_opening_float_ledger(
  p_desk_id uuid,
  p_agent_id uuid,
  p_amount numeric,
  p_reason text,
  p_evidence_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Not authenticated');
  END IF;
  IF NOT public.finops_edit_authorized(
       'merchant_opening_float_ledger',
       jsonb_build_object('desk_id', p_desk_id, 'agent_id', p_agent_id, 'amount', p_amount)
     ) THEN
    RETURN jsonb_build_object('ok', false, 'unauthorized', true,
      'reason', 'Blocked: only the Financial Ops role can edit merchant balances. This attempt has been logged and reported.');
  END IF;
  RETURN public.post_merchant_opening_float_ledger(p_desk_id, p_agent_id, p_amount, p_reason, p_evidence_note);
END;
$function$;

CREATE OR REPLACE FUNCTION public.finops_post_merchant_evidenced_writedown(
  p_desk_id uuid,
  p_agent_id uuid,
  p_amount numeric,
  p_reason text,
  p_evidence_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Not authenticated');
  END IF;
  IF NOT public.finops_edit_authorized(
       'merchant_evidenced_writedown',
       jsonb_build_object('desk_id', p_desk_id, 'agent_id', p_agent_id, 'amount', p_amount)
     ) THEN
    RETURN jsonb_build_object('ok', false, 'unauthorized', true,
      'reason', 'Blocked: only the Financial Ops role can edit merchant balances. This attempt has been logged and reported.');
  END IF;
  RETURN public.post_merchant_evidenced_writedown(p_desk_id, p_agent_id, p_amount, p_reason, p_evidence_note);
END;
$function$;

CREATE OR REPLACE FUNCTION public.finops_set_merchant_desk_float_to(
  p_desk_id uuid,
  p_agent_id uuid,
  p_target numeric,
  p_reason text,
  p_evidence_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Not authenticated');
  END IF;
  IF NOT public.finops_edit_authorized(
       'merchant_set_desk_float',
       jsonb_build_object('desk_id', p_desk_id, 'agent_id', p_agent_id, 'target', p_target)
     ) THEN
    RETURN jsonb_build_object('ok', false, 'unauthorized', true,
      'reason', 'Blocked: only the Financial Ops role can edit merchant balances. This attempt has been logged and reported.');
  END IF;
  RETURN public.set_merchant_desk_float_to(p_desk_id, p_agent_id, p_target, p_reason, p_evidence_note);
END;
$function$;

REVOKE ALL ON FUNCTION public.finops_post_merchant_opening_float_ledger(uuid, uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finops_post_merchant_opening_float_ledger(uuid, uuid, numeric, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.finops_post_merchant_evidenced_writedown(uuid, uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finops_post_merchant_evidenced_writedown(uuid, uuid, numeric, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.finops_set_merchant_desk_float_to(uuid, uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finops_set_merchant_desk_float_to(uuid, uuid, numeric, text, text) TO authenticated, service_role;

-- Underlying correction routines are no longer reachable from the app/API.
REVOKE ALL ON FUNCTION public.post_merchant_opening_float_ledger(uuid, uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_merchant_opening_float_ledger(uuid, uuid, numeric, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.post_merchant_evidenced_writedown(uuid, uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_merchant_evidenced_writedown(uuid, uuid, numeric, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.set_merchant_desk_float_to(uuid, uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_merchant_desk_float_to(uuid, uuid, numeric, text, text) TO service_role;
