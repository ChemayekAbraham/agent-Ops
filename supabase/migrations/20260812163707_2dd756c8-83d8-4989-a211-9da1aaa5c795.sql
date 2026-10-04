CREATE OR REPLACE FUNCTION public.sweep_withdrawal_settlement_states(p_limit integer DEFAULT 200, p_days integer DEFAULT 45)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_done int := 0;
  v_err int := 0;
BEGIN
  FOR r IN
    SELECT w.id
    FROM public.withdrawal_requests w
    JOIN public.merchant_payout_funding f ON f.withdrawal_id = w.id
    WHERE w.status IN ('paid','completed','disbursed')
      AND coalesce(w.settlement_state, 'pending') = 'pending'
      AND w.created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 45)))
    ORDER BY w.created_at DESC
    LIMIT greatest(1, least(coalesce(p_limit, 200), 500))
  LOOP
    BEGIN
      PERFORM public.record_withdrawal_settlement_state(r.id);
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      v_err := v_err + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'recomputed', v_done, 'errors', v_err);
END;
$function$;

REVOKE ALL ON FUNCTION public.sweep_withdrawal_settlement_states(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_withdrawal_settlement_states(integer, integer) TO service_role;

SELECT cron.schedule(
  'sweep-withdrawal-settlement-states',
  '*/10 * * * *',
  $$SELECT public.sweep_withdrawal_settlement_states(200, 45);$$
);