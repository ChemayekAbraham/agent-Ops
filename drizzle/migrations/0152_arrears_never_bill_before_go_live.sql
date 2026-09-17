-- Arrears has no history: it starts on rent_arrears_go_live() and never backfills.
--
-- The day-1 catch-up added on 2026-09-17 pinned every plan back to its own
-- term_start, including days before go-live. v_rent_day_ledger hides those days,
-- but the FIFO waterfall still settled real collections onto them, so a paying
-- tenant's money disappeared from the visible ledger and they showed as many
-- days behind. Floor every biller and the waterfall at the go-live date.

CREATE OR REPLACE FUNCTION public.pin_agent_expected_day(p_day date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_rows int := 0; v_fallback int := 0;
begin
  if p_day is null
     or p_day > (now() at time zone 'Africa/Kampala')::date
     or p_day < public.rent_arrears_go_live() then
    return 0;
  end if;

  insert into public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  select p_day, g.rent_request_id, s.agent_id, s.tenant_id, g.amount
  from public.rent_plan_schedule_days(p_day, p_day) g
  join public.v_rent_plan_schedule s on s.rent_request_id = g.rent_request_id
  on conflict (day, rent_request_id) do nothing;

  get diagnostics v_rows = row_count;

  -- Past-term fallback, scoped to agents with nothing scheduled for the day.
  with agents_with_bill as (
    select distinct agent_id
    from public.agent_expected_day_plans
    where day = p_day and agent_id is not null
  ), past_term as (
    select coalesce(rr.assigned_agent_id, rr.agent_id) as agent_id,
           rr.id as rent_request_id,
           rr.tenant_id,
           least(rr.daily_repayment,
                 coalesce(rr.total_repayment, 0) - coalesce(rr.amount_repaid, 0)) as expected_ugx
    from public.rent_requests rr
    where rr.status in ('funded', 'repaying')
      and coalesce(rr.agent_payment_status, 'paying') <> 'not_paying'
      and lower(coalesce(rr.repayment_frequency, 'daily')) <> 'weekly'
      and coalesce(rr.daily_repayment, 0) > 0
      and coalesce(rr.total_repayment, 0) - coalesce(rr.amount_repaid, 0) > 0
      and (coalesce(rr.repayment_starts_on, (rr.funded_at at time zone 'Africa/Kampala')::date)
           + coalesce(rr.duration_days, 0) - 1) < p_day
      and coalesce(rr.assigned_agent_id, rr.agent_id) is not null
      and not exists (
        select 1 from agents_with_bill a
        where a.agent_id = coalesce(rr.assigned_agent_id, rr.agent_id)
      )
  )
  insert into public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  select p_day, pt.rent_request_id, pt.agent_id, pt.tenant_id, pt.expected_ugx
  from past_term pt
  where pt.expected_ugx > 0
  on conflict (day, rent_request_id) do nothing;

  get diagnostics v_fallback = row_count;

  return v_rows + v_fallback;
end;
$function$;

CREATE OR REPLACE FUNCTION public.pin_agent_expected_day_for_plan(p_rent_request_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_from date;
  v_rows int := 0;
BEGIN
  IF p_rent_request_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Never earlier than go-live: arrears has no pre-launch history.
  SELECT GREATEST(s.term_start, public.rent_arrears_go_live()) INTO v_from
  FROM public.v_rent_plan_schedule s
  WHERE s.rent_request_id = p_rent_request_id;

  IF v_from IS NULL OR v_from > v_today THEN
    RETURN 0;
  END IF;

  INSERT INTO public.agent_expected_day_plans (day, rent_request_id, agent_id, tenant_id, expected_ugx)
  SELECT g.due_on, g.rent_request_id, s.agent_id, s.tenant_id, g.amount
  FROM public.rent_plan_schedule_days(v_from, v_today) g
  JOIN public.v_rent_plan_schedule s ON s.rent_request_id = g.rent_request_id
  WHERE g.rent_request_id = p_rent_request_id
  ON CONFLICT (day, rent_request_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rent_apply_collections_to_days(p_rent_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows int := 0;
  v_amount numeric := 0;
  v_backfilled int := 0;
BEGIN
  IF p_rent_request_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no_plan');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_rent_request_id::text, 0));

  v_backfilled := public.pin_agent_expected_day_for_plan(p_rent_request_id);

  DELETE FROM public.rent_day_settlements WHERE rent_request_id = p_rent_request_id;

  WITH funds AS (
    SELECT ac.id AS collection_id,
           ac.amount AS unapplied_ugx,
           COALESCE(SUM(ac.amount) OVER (ORDER BY ac.created_at, ac.id
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS f_start
    FROM public.agent_collections ac
    WHERE ac.rent_request_id = p_rent_request_id
      AND ac.amount > 0
      AND COALESCE(ac.notes, '') NOT ILIKE '%[REVERSED:%'
  ), open_days AS (
    -- Only days the arrears ledger can see. Settling onto an invisible
    -- pre-go-live day would hide a real payment and fake a missed day.
    SELECT ep.day,
           ep.expected_ugx AS remaining_ugx,
           COALESCE(SUM(ep.expected_ugx) OVER (ORDER BY ep.day
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS d_start
    FROM public.agent_expected_day_plans ep
    WHERE ep.rent_request_id = p_rent_request_id
      AND ep.day >= public.rent_arrears_go_live()
  ), matched AS (
    SELECT d.day,
           f.collection_id,
           LEAST(f.f_start + f.unapplied_ugx, d.d_start + d.remaining_ugx)
             - GREATEST(f.f_start, d.d_start) AS amount
    FROM funds f
    JOIN open_days d
      ON LEAST(f.f_start + f.unapplied_ugx, d.d_start + d.remaining_ugx)
         > GREATEST(f.f_start, d.d_start)
  ), ins AS (
    INSERT INTO public.rent_day_settlements (rent_request_id, day, collection_id, amount)
    SELECT p_rent_request_id, m.day, m.collection_id, m.amount
    FROM matched m
    WHERE m.amount > 0
    ON CONFLICT (collection_id, day)
      DO UPDATE SET amount = EXCLUDED.amount
    RETURNING amount
  )
  SELECT count(*)::int, COALESCE(SUM(amount), 0) INTO v_rows, v_amount FROM ins;

  RETURN jsonb_build_object(
    'status', 'applied',
    'rent_request_id', p_rent_request_id,
    'rows', v_rows,
    'amount_applied', v_amount,
    'days_backfilled', v_backfilled
  );
END;
$function$;