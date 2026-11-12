CREATE OR REPLACE FUNCTION public.trg_bike_sweep_block_withdrawal_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public._bike_sweep_blocks_outflow(NEW.user_id) THEN
    RAISE EXCEPTION 'BIKE_LEASE_FIRST: withdrawals are paused until the bike lease is fully paid' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $function$
