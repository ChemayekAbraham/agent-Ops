CREATE OR REPLACE FUNCTION public.requisition_link_submission_claim(p_token text)
RETURNS TABLE(link_id uuid, label text, department text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link public.requisition_links%ROWTYPE;
BEGIN
  SELECT * INTO v_link
  FROM public.requisition_links
  WHERE token = p_token
    AND revoked_at IS NULL
    AND expires_at > now()
    AND (max_submissions IS NULL OR submission_count < max_submissions)
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_or_exhausted_link'; END IF;

  RETURN QUERY SELECT v_link.id, v_link.label, v_link.department;
END;
$$;

GRANT EXECUTE ON FUNCTION public.requisition_link_submission_claim(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.requisition_link_submission_increment(p_link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.requisition_links
  SET submission_count = submission_count + 1,
      updated_at = now()
  WHERE id = p_link_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.requisition_link_submission_increment(uuid) TO service_role;

DROP FUNCTION IF EXISTS public.requisition_link_submission_claim(text);
DROP FUNCTION IF EXISTS public.requisition_link_submission_increment(uuid);