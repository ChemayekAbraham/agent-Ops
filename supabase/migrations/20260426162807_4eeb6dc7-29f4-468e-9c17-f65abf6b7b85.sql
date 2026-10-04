CREATE OR REPLACE FUNCTION public.log_finops_provider_mismatch(
  _picked_deposit_id uuid,
  _picked_provider text,
  _selected_provider text,
  _attempted_amount numeric DEFAULT NULL,
  _attempted_tid text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _event_id uuid;
  _caller uuid := auth.uid();
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  INSERT INTO public.system_events (
    event_type,
    user_id,
    related_entity_type,
    related_entity_id,
    metadata
  ) VALUES (
    'finops_provider_mismatch',
    _caller,
    'pending_deposit',
    _picked_deposit_id,
    jsonb_build_object(
      'picked_provider', _picked_provider,
      'selected_provider', _selected_provider,
      'attempted_amount', _attempted_amount,
      'attempted_tid', _attempted_tid,
      'source', 'tid_verification'
    )
  )
  RETURNING id INTO _event_id;

  RETURN _event_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_finops_provider_mismatch(uuid, text, text, numeric, text) TO authenticated;