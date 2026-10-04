CREATE OR REPLACE FUNCTION public.defer_email(queue_name TEXT, message_id BIGINT, delay_seconds INT DEFAULT 120)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pgmq.set_vt(queue_name, message_id, GREATEST(delay_seconds, 1));
  RETURN TRUE;
EXCEPTION WHEN undefined_table OR undefined_function THEN
  RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.defer_email(TEXT, BIGINT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.defer_email(TEXT, BIGINT, INT) TO service_role;