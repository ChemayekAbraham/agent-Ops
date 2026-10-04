CREATE OR REPLACE FUNCTION public.reconcile_advance_statuses()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_overdue integer := 0;
  v_completed integer := 0;
BEGIN
  -- Cycle ended but money still owed -> overdue
  UPDATE public.agent_advances
     SET status = 'overdue',
         updated_at = now()
   WHERE status = 'active'
     AND expires_at IS NOT NULL
     AND expires_at < now()
     AND outstanding_balance > 0;
  v_overdue := COALESCE(ROW_COUNT_HACK(), 0);
  GET DIAGNOSTICS v_overdue = ROW_COUNT;

  -- Fully repaid -> completed, arrears cleared
  UPDATE public.agent_advances
     SET status = 'completed',
         arrears_balance = 0,
         updated_at = now()
   WHERE status IN ('active', 'overdue')
     AND outstanding_balance <= 0;
  GET DIAGNOSTICS v_completed = ROW_COUNT;

  RETURN jsonb_build_object(
    'marked_overdue', v_overdue,
    'marked_completed', v_completed,
    'ran_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_advance_statuses() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_advance_statuses() TO service_role;

COMMENT ON FUNCTION public.reconcile_advance_statuses() IS
'Hourly self-heal for agent advance lifecycle: expired-with-balance -> overdue, zero-balance -> completed (arrears zeroed). Never touches money amounts.';