-- 1) Widen the read policies to every surface allowed into /admin/financial-ops.
DROP POLICY IF EXISTS "staff can read gmail_transactions" ON public.gmail_transactions;
CREATE POLICY "staff can read gmail_transactions"
ON public.gmail_transactions
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  -- employees/staff holding the financial-ops dashboard permission
  OR public.is_financial_ops_staff(auth.uid())
);

DROP POLICY IF EXISTS "staff can read gmail_poll_state" ON public.gmail_poll_state;
CREATE POLICY "staff can read gmail_poll_state"
ON public.gmail_poll_state
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'manager'::app_role)
  OR public.has_role(auth.uid(), 'super_admin'::app_role)
  OR public.has_role(auth.uid(), 'cfo'::app_role)
  OR public.has_role(auth.uid(), 'coo'::app_role)
  OR public.has_role(auth.uid(), 'financial_ops'::app_role)
  OR public.has_role(auth.uid(), 'operations'::app_role)
  OR public.is_financial_ops_staff(auth.uid())
);

-- 2) Intake-silence heartbeat: one authoritative read of poller vs. actual inserts.
CREATE OR REPLACE FUNCTION public.get_gmail_intake_health(p_silence_minutes integer DEFAULT 30)
RETURNS TABLE (
  last_polled_at timestamptz,
  last_status text,
  last_error text,
  cutoff_at timestamptz,
  cutoff_is_future boolean,
  last_insert_at timestamptz,
  silence_minutes numeric,
  poll_stale boolean,
  intake_silent boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_threshold integer := GREATEST(COALESCE(p_silence_minutes, 30), 1);
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'financial_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.is_financial_ops_staff(auth.uid())
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  RETURN QUERY
  WITH st AS (
    SELECT s.last_polled_at,
           s.last_status,
           s.last_error,
           to_timestamp(NULLIF(s.last_internal_date_ms, 0) / 1000.0) AS cutoff_at
    FROM public.gmail_poll_state s
    WHERE s.id = 1
  ), ins AS (
    SELECT max(g.created_at) AS last_insert_at FROM public.gmail_transactions g
  )
  SELECT st.last_polled_at,
         st.last_status,
         st.last_error,
         st.cutoff_at,
         (st.cutoff_at IS NOT NULL AND st.cutoff_at > now() + interval '2 minutes') AS cutoff_is_future,
         ins.last_insert_at,
         ROUND(EXTRACT(EPOCH FROM (now() - ins.last_insert_at)) / 60.0, 1) AS silence_minutes,
         (st.last_polled_at IS NULL OR st.last_polled_at < now() - interval '15 minutes') AS poll_stale,
         (
           st.last_status = 'ok'
           AND st.last_polled_at IS NOT NULL
           AND st.last_polled_at > now() - interval '15 minutes'
           AND (ins.last_insert_at IS NULL OR ins.last_insert_at < now() - make_interval(mins => v_threshold))
         ) AS intake_silent
  FROM st CROSS JOIN ins;
END;
$$;

REVOKE ALL ON FUNCTION public.get_gmail_intake_health(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gmail_intake_health(integer) TO authenticated, service_role;