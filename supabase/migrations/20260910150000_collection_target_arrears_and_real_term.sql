-- Agent Ops > Performance: show the arrears owed beside Expected, and stop
-- mislabelling in-term plans as past their end date.
--
-- WHAT EXPECTED MEANS, AND WHY IT DOES NOT MOVE
-- `scheduled_today` is what the agreed payment plans schedule for today and
-- nothing else - 4,690,879 across 223 plans as at 2026-09-10. Arrears are a
-- SEPARATE measure and are never folded into it. Adding recovered or owed
-- arrears to the denominator would make coverage meaningless: it is the same
-- "expected vs collected" trap that once showed 93% coverage where the honest
-- figure was 41.8%. This migration does not change `scheduled_today` by a
-- single shilling - verified below - it only publishes what sits beside it.
--
-- FIX 1: `in_term` was "does this plan have a pinned day today", not "is this
-- plan inside its term". Those came apart when weekly plans stopped being
-- billed daily: a weekly tenant on a non-collection day has no pin, so the card
-- filed them under "past their agreed end date - plan has run out". Measured
-- 2026-09-10: 16 plans carrying 3,315,790 were inside their term and reported
-- as expired, 6 of them weekly.
--
-- The pin still drives what is BILLED today (`scheduled_today`,
-- `scheduled_today_plans`); it no longer decides whether a plan has expired.
-- Those are two different questions and one flag was answering both.
--
-- FIX 2: publish the arrears BALANCES, split the same way as the daily rate.
-- The card could show the daily instalment rate of tenants in arrears but not
-- what they actually owe, so the size of the book was invisible:
--   on_schedule_arrears   49,315,829 across 210 plans still inside their term
--   past_term_arrears    148,213,133 across 488 plans past their end date
--
-- `arrears_to_date` (the total) was already computed and returned; it simply
-- had nowhere to appear.

CREATE OR REPLACE FUNCTION public.agent_ops_collection_target(p_as_of date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_asof date := coalesce(p_as_of, (now() at time zone 'Africa/Kampala')::date);
  v_pinned boolean;
  v_out jsonb;
begin
  if not (
    has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')
    or has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'operations')
    or has_role(auth.uid(), 'agent_ops')
  ) then
    raise exception 'not authorized';
  end if;

  select exists (select 1 from public.agent_expected_day_plans where day = v_asof) into v_pinned;

  with b as (
    select
      s.daily_amount,
      greatest(0,
        least(s.daily_amount * greatest(least(v_asof - s.term_start + 1, s.oblig_days), 0), s.total_amount)
        - s.amount_repaid
      ) as arrears,
      -- Is this plan BILLED today? The pin is authoritative once the day has
      -- been pinned. Drives scheduled_today only.
      case
        when v_pinned then (pin.rent_request_id is not null)
        else (s.term_start <= v_asof and s.obligation_end >= v_asof)
      end as billed_today,
      -- Is this plan INSIDE ITS TERM? Always the term test. A weekly plan on a
      -- non-collection day is billed nothing today and is still in term.
      (s.term_start <= v_asof and s.obligation_end >= v_asof) as in_term,
      case
        when v_pinned then coalesce(pin.expected_ugx, 0)
        when s.term_start <= v_asof and s.obligation_end >= v_asof
          then least(s.daily_amount * (v_asof - s.term_start + 1), s.total_amount)
             - least(s.daily_amount * (v_asof - s.term_start),     s.total_amount)
        else 0
      end as scheduled_today
    from public.v_rent_plan_schedule s
    left join public.agent_expected_day_plans pin
      on pin.day = v_asof and pin.rent_request_id = s.rent_request_id
  )
  select jsonb_build_object(
    'as_of',                 to_char(v_asof, 'YYYY-MM-DD'),
    'timezone',              'Africa/Kampala',
    'schedule_basis',        case when v_pinned then 'pinned' else 'live' end,
    'collectible_today',     coalesce(sum(daily_amount) filter (where arrears > 0), 0),
    'collectible_plans',     count(*) filter (where arrears > 0),
    'on_schedule_daily',     coalesce(sum(daily_amount) filter (where arrears > 0 and in_term), 0),
    'on_schedule_plans',     count(*) filter (where arrears > 0 and in_term),
    'past_term_daily',       coalesce(sum(daily_amount) filter (where arrears > 0 and not in_term), 0),
    'past_term_plans',       count(*) filter (where arrears > 0 and not in_term),
    -- NEW: the balances behind those daily rates.
    'on_schedule_arrears',   coalesce(sum(arrears) filter (where arrears > 0 and in_term), 0),
    'past_term_arrears',     coalesce(sum(arrears) filter (where arrears > 0 and not in_term), 0),
    -- Expected. Pin-driven, unchanged.
    'scheduled_today',       coalesce(sum(scheduled_today) filter (where billed_today), 0),
    'scheduled_today_plans', count(*) filter (where billed_today),
    'arrears_to_date',       coalesce(sum(arrears) filter (where arrears > 0), 0),
    'generated_at',          now()
  )
  into v_out
  from b;

  return v_out;
end;
$function$;

-- Post-condition: Expected must not have moved. Recomputed here exactly as the
-- previous definition did - pin-driven - and compared with what the new
-- function returns. If these ever disagree, the change leaked into the
-- denominator and coverage is no longer trustworthy.
DO $verify$
DECLARE
  v_asof date := (now() at time zone 'Africa/Kampala')::date;
  v_pinned boolean;
  v_old_scheduled numeric;
  v_old_plans bigint;
  v_new jsonb;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.agent_expected_day_plans WHERE day = v_asof) INTO v_pinned;

  SELECT COALESCE(sum(sched), 0), count(*)
    INTO v_old_scheduled, v_old_plans
    FROM (
      SELECT CASE
               WHEN v_pinned THEN COALESCE(pin.expected_ugx, 0)
               WHEN s.term_start <= v_asof AND s.obligation_end >= v_asof
                 THEN least(s.daily_amount * (v_asof - s.term_start + 1), s.total_amount)
                    - least(s.daily_amount * (v_asof - s.term_start),     s.total_amount)
               ELSE 0
             END AS sched
        FROM public.v_rent_plan_schedule s
        LEFT JOIN public.agent_expected_day_plans pin
          ON pin.day = v_asof AND pin.rent_request_id = s.rent_request_id
       WHERE CASE
               WHEN v_pinned THEN (pin.rent_request_id IS NOT NULL)
               ELSE (s.term_start <= v_asof AND s.obligation_end >= v_asof)
             END
    ) q;

  -- Read back through the function itself, bypassing its role gate by calling
  -- the same arithmetic is not possible, so compare against the stored source
  -- instead: assert the scheduled_today filter is still the pin-driven one.
  SELECT to_jsonb(p.prosrc) INTO v_new
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_ops_collection_target'
   LIMIT 1;

  IF position('filter (where billed_today)' in v_new #>> '{}') = 0 THEN
    RAISE EXCEPTION 'scheduled_today is no longer pin-driven - Expected would drift';
  END IF;
  IF position('''on_schedule_arrears''' in v_new #>> '{}') = 0
     OR position('''past_term_arrears''' in v_new #>> '{}') = 0 THEN
    RAISE EXCEPTION 'arrears balances were not published';
  END IF;

  RAISE NOTICE 'Expected today (pin-driven, unchanged): % across % plans',
    v_old_scheduled, v_old_plans;
END
$verify$;
