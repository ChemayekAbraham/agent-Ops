-- Calling Center caller view: two figures that genuinely don't exist anywhere
-- yet — "days remaining in the plan" and "amount needed per remaining
-- day/week to finish on time" — read off the existing authoritative
-- v_rent_plan_schedule (the same view rent_plan_schedule_days() and every
-- other scheduled-rent figure in the platform already derives from).
--
-- No new business rule: term_end is v_rent_plan_schedule's own
-- (repayment_starts_on + duration_days - 1); the "per remaining day" figure
-- is plain division of the plan's already-authoritative outstanding balance
-- by the days left, matching how the platform already turns a daily figure
-- into a weekly one everywhere else (x7 -- see rent_plan_schedule_days()).
-- Nothing about the existing caller-view panels, their data or their layout
-- changes.

CREATE OR REPLACE FUNCTION public.cc_plan_pace(p_rent_request_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'rent_request_id', s.rent_request_id,
    'term_end', s.term_end,
    'total_amount', s.total_amount,
    'amount_repaid', s.amount_repaid,
    'outstanding', GREATEST(s.total_amount - s.amount_repaid, 0),
    'days_remaining', (s.term_end - CURRENT_DATE),
    'amount_per_remaining_day',
      CASE WHEN (s.term_end - CURRENT_DATE) > 0
           THEN ROUND(GREATEST(s.total_amount - s.amount_repaid, 0) / (s.term_end - CURRENT_DATE))
           ELSE NULL END
  )
  FROM public.v_rent_plan_schedule s
  WHERE s.rent_request_id = p_rent_request_id
    AND auth.uid() IS NOT NULL
    AND public.is_welile_staff(auth.uid());
$$;

COMMENT ON FUNCTION public.cc_plan_pace(uuid) IS
'Read-only pacing figures for a live rent plan: days left against v_rent_plan_schedule.term_end, and the amount per remaining day needed to finish on time. Returns no row when the plan is not in v_rent_plan_schedule (not funded/repaying, no outstanding balance, or landlord disbursement not yet evidenced) -- callers must treat a null result as "nothing to show", not an error.';

REVOKE ALL ON FUNCTION public.cc_plan_pace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cc_plan_pace(uuid) TO authenticated;
