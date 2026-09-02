CREATE OR REPLACE FUNCTION public.consume_requisition_link_slot(p_token text)
RETURNS TABLE(link_id uuid, label text, department text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.requisition_links
  SET submission_count = submission_count + 1,
      updated_at = now()
  WHERE token = p_token
    AND is_active = true
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())
    AND (max_submissions IS NULL OR submission_count < max_submissions)
  RETURNING id, requisition_links.label, requisition_links.department;
END;
$$;

GRANT EXECUTE ON FUNCTION public.consume_requisition_link_slot(text) TO service_role;