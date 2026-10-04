
-- 1. Normalizer: strip everything that isn't a digit so 'MP40809017595' == '40809017595'.
CREATE OR REPLACE FUNCTION public.normalize_momo_tid(p_tid text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(regexp_replace(COALESCE(p_tid, ''), '[^0-9]', '', 'g'), '');
$$;

-- 2. Trigger function: on INSERT or TID change for an operational-float row,
--    flag every other live op-float row sharing the same normalized TID
--    (and flag the incoming row too).
CREATE OR REPLACE FUNCTION public.flag_operational_float_tid_duplicates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm        text;
  v_match_ids   uuid[];
  v_match_count int;
  v_note_tail   text;
BEGIN
  IF NEW.deposit_purpose IS DISTINCT FROM 'operational_float' THEN
    RETURN NEW;
  END IF;

  v_norm := public.normalize_momo_tid(NEW.transaction_id);
  IF v_norm IS NULL OR length(v_norm) < 6 THEN
    RETURN NEW; -- nothing meaningful to compare
  END IF;

  -- Skip noise: don't re-flag if TID hasn't actually changed on UPDATE.
  IF TG_OP = 'UPDATE'
     AND public.normalize_momo_tid(OLD.transaction_id) IS NOT DISTINCT FROM v_norm THEN
    RETURN NEW;
  END IF;

  SELECT array_agg(id), count(*)
    INTO v_match_ids, v_match_count
    FROM public.deposit_requests
   WHERE id <> NEW.id
     AND deposit_purpose = 'operational_float'
     AND status NOT IN ('cancelled')
     AND public.normalize_momo_tid(transaction_id) = v_norm;

  IF v_match_count IS NULL OR v_match_count = 0 THEN
    RETURN NEW;
  END IF;

  v_note_tail := format(
    E'\n[auto %s] Duplicate operational-float TID detected (normalized %s). Conflicts with %s other row(s): %s',
    to_char(now(), 'YYYY-MM-DD HH24:MI'),
    v_norm,
    v_match_count,
    array_to_string(v_match_ids, ', ')
  );

  -- Flag the incoming row.
  NEW.audit_flagged := true;
  NEW.notes := COALESCE(NEW.notes, '') || v_note_tail;

  -- Flag every conflicting row so Fin Ops sees the warning from either side.
  UPDATE public.deposit_requests
     SET audit_flagged = true,
         notes = COALESCE(notes, '')
           || format(
             E'\n[auto %s] Duplicate operational-float TID detected (normalized %s). Conflicts with row %s.',
             to_char(now(), 'YYYY-MM-DD HH24:MI'),
             v_norm,
             NEW.id
           ),
         updated_at = now()
   WHERE id = ANY(v_match_ids);

  -- Audit log (one row per pair, anchored to the incoming request).
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    NEW.user_id,
    'operational_float_tid_duplicate_flagged',
    'deposit_requests',
    NEW.id,
    jsonb_build_object(
      'normalized_tid', v_norm,
      'raw_tid', NEW.transaction_id,
      'conflict_ids', to_jsonb(v_match_ids),
      'conflict_count', v_match_count,
      'detected_at', now()
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_flag_operational_float_tid_duplicates ON public.deposit_requests;
CREATE TRIGGER trg_flag_operational_float_tid_duplicates
BEFORE INSERT OR UPDATE OF transaction_id, deposit_purpose
ON public.deposit_requests
FOR EACH ROW
EXECUTE FUNCTION public.flag_operational_float_tid_duplicates();

-- 3. View: every current duplicate group of operational-float TIDs (≥ 2 live rows).
CREATE OR REPLACE VIEW public.v_operational_float_tid_duplicates AS
SELECT
  public.normalize_momo_tid(transaction_id)        AS normalized_tid,
  count(*)                                         AS row_count,
  array_agg(id ORDER BY created_at)                AS request_ids,
  array_agg(status ORDER BY created_at)            AS statuses,
  array_agg(user_id ORDER BY created_at)           AS user_ids,
  array_agg(amount ORDER BY created_at)            AS amounts,
  min(created_at)                                  AS first_seen_at,
  max(created_at)                                  AS last_seen_at
FROM public.deposit_requests
WHERE deposit_purpose = 'operational_float'
  AND status <> 'cancelled'
  AND public.normalize_momo_tid(transaction_id) IS NOT NULL
GROUP BY public.normalize_momo_tid(transaction_id)
HAVING count(*) >= 2;

GRANT SELECT ON public.v_operational_float_tid_duplicates TO authenticated;
