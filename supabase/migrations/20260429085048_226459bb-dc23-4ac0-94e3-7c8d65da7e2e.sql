CREATE OR REPLACE FUNCTION public.cfo_correct_trail_entry(
  p_audit_id uuid,
  p_new_tid text,
  p_new_reason text,
  p_new_target_user_id uuid,
  p_correction_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _row public.audit_logs%ROWTYPE;
  _meta jsonb;
  _history jsonb;
  _snapshot jsonb;
  _target_name text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'cfo'::app_role) THEN
    RAISE EXCEPTION 'Only the CFO may correct trail entries';
  END IF;

  IF p_correction_reason IS NULL OR length(trim(p_correction_reason)) < 10 THEN
    RAISE EXCEPTION 'Correction reason must be at least 10 characters';
  END IF;

  SELECT * INTO _row FROM public.audit_logs WHERE id = p_audit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trail entry not found';
  END IF;

  _meta := COALESCE(_row.metadata, '{}'::jsonb);
  _history := COALESCE(_meta->'edit_history', '[]'::jsonb);

  -- Snapshot current values before mutation
  _snapshot := jsonb_build_object(
    'edited_at', now(),
    'edited_by', auth.uid(),
    'reason', p_correction_reason,
    'previous', jsonb_build_object(
      'tid', COALESCE(
        _meta->>'tid',
        _meta->>'transaction_id',
        _meta->>'tpay_reference',
        _meta->>'batch_reference'
      ),
      'reason', _meta->>'reason',
      'description', _meta->>'description',
      'target_user_id', _meta->>'target_user_id',
      'target_name', _meta->>'target_name',
      'user_name', _meta->>'user_name'
    )
  );

  _meta := jsonb_set(_meta, '{edit_history}', _history || _snapshot, true);

  -- Apply TID overwrite (canonical key: tid; mirror to legacy keys when they were present)
  IF p_new_tid IS NOT NULL AND length(trim(p_new_tid)) > 0 THEN
    _meta := jsonb_set(_meta, '{tid}', to_jsonb(trim(p_new_tid)), true);
    IF _meta ? 'transaction_id' THEN
      _meta := jsonb_set(_meta, '{transaction_id}', to_jsonb(trim(p_new_tid)), true);
    END IF;
    IF _meta ? 'tpay_reference' THEN
      _meta := jsonb_set(_meta, '{tpay_reference}', to_jsonb(trim(p_new_tid)), true);
    END IF;
    IF _meta ? 'batch_reference' THEN
      _meta := jsonb_set(_meta, '{batch_reference}', to_jsonb(trim(p_new_tid)), true);
    END IF;
  END IF;

  -- Apply reason / description overwrite
  IF p_new_reason IS NOT NULL AND length(trim(p_new_reason)) > 0 THEN
    _meta := jsonb_set(_meta, '{reason}', to_jsonb(trim(p_new_reason)), true);
    _meta := jsonb_set(_meta, '{description}', to_jsonb(trim(p_new_reason)), true);
  END IF;

  -- Apply target user re-link
  IF p_new_target_user_id IS NOT NULL THEN
    SELECT full_name INTO _target_name FROM public.profiles WHERE id = p_new_target_user_id;
    _meta := jsonb_set(_meta, '{target_user_id}', to_jsonb(p_new_target_user_id), true);
    _meta := jsonb_set(_meta, '{target_name}', to_jsonb(COALESCE(_target_name, '')), true);
    IF _meta ? 'user_name' THEN
      _meta := jsonb_set(_meta, '{user_name}', to_jsonb(COALESCE(_target_name, '')), true);
    END IF;
    IF _meta ? 'agent_name' THEN
      _meta := jsonb_set(_meta, '{agent_name}', to_jsonb(COALESCE(_target_name, '')), true);
    END IF;
  END IF;

  _meta := jsonb_set(_meta, '{last_corrected_at}', to_jsonb(now()), true);
  _meta := jsonb_set(_meta, '{last_corrected_by}', to_jsonb(auth.uid()), true);

  UPDATE public.audit_logs
     SET metadata = _meta
   WHERE id = p_audit_id;

  -- Separate audit row capturing the correction itself
  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, reason, metadata)
  VALUES (
    'cfo_trail_corrected',
    'audit_logs',
    p_audit_id,
    auth.uid(),
    p_correction_reason,
    jsonb_build_object(
      'corrected_audit_id', p_audit_id,
      'original_action_type', _row.action_type,
      'snapshot', _snapshot,
      'new_tid', p_new_tid,
      'new_reason', p_new_reason,
      'new_target_user_id', p_new_target_user_id
    )
  );

  RETURN jsonb_build_object('ok', true, 'audit_id', p_audit_id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cfo_correct_trail_entry(uuid, text, text, uuid, text) TO authenticated;