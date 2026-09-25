-- A defaulter is measured from when repayment STARTS, not from funding.
--
-- THE DEFECT, AND IT IS MINE
-- `v_crm_call_section` decides the tenant `defaulter` subtype with:
--
--     r.funded_at IS NOT NULL
--     AND (r.funded_at + make_interval(days => COALESCE(r.duration_days,0))) < now()
--     AND total_repayment - amount_repaid > 0
--
-- Two things wrong with it, both introduced in 20260922110000.
--
-- 1. IT MEASURES THE TERM FROM FUNDING. A plan whose repayment starts later
--    than funded+1 is called a defaulter early by exactly the size of that gap.
--    Patience Ruba's start was moved to 25 September on 24 September; her term
--    effectively runs to 24 October, and this test would have called her a
--    defaulter from 17 October - seven days early, on a plan she had not yet
--    fallen behind on.
--
-- 2. IT FLAGS PLANS THAT ARE NOT LIVE. `funded_at IS NOT NULL` is the only
--    status guard, so rejected and completed plans carrying a residual balance
--    are counted. 16 tenants are flagged that way today.
--
-- THE REST OF THE PLATFORM ALREADY HAD THIS RIGHT
-- Four other objects compute the same thing, and all four agree with each
-- other and disagree with mine:
--
--   pin_agent_expected_day      coalesce(repayment_starts_on, funded_at::date)
--   v_agent_daily_eligibility     + coalesce(duration_days,0) - 1
--   v_rent_plan_schedule        (term_end, inclusive of the last billed day)
--
-- Note the `- 1`: the term ends ON the last billed day, so the comparison is
-- `term_end < today`. Mine had no `- 1` and was therefore also a day out
-- against the house convention, independently of the funded_at problem.
--
-- This migration changes ONE object to match the four that were already
-- correct. It does not invent a new rule.
--
-- DELIBERATELY NOT CHANGED, though both mention funded_at and duration_days:
--
--   run_fee_revenue_recognition   (now() - funded_at) / duration_days as a
--     straight-line percentage. That is revenue recognised over the period the
--     money has been out, which is a funding question, not a repayment one.
--     Repointing it at repayment_starts_on would move recognised revenue.
--
--   v_tpsp_projection_base        cycle_end_date for a cash-flow projection,
--     keyed on when cash left. Also a funding question.
--
-- Neither is a defaulter test and neither is touched.
--
-- MEASURED against live data before writing:
--   current rule   498 tenants
--   house rule     505 tenants
--   of the current 498, 16 are plans that are neither funded nor repaying
--
-- Patched from the live definition rather than restated, because this view has
-- been rewritten three times this week and the copy in any one migration file
-- is not necessarily the copy that is running.

DO $fix$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_viewdef('public.v_crm_call_section'::regclass, true) INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'v_crm_call_section is missing';
  END IF;

  IF position('repayment_starts_on' in v_def) > 0 THEN
    RAISE NOTICE 'defaulter already measured from repayment_starts_on - nothing to do';
    RETURN;
  END IF;

  v_old := 'r.funded_at IS NOT NULL AND (r.funded_at + make_interval(days => COALESCE(r.duration_days, 0))) < now() '
        || 'AND (COALESCE(r.total_repayment, 0::numeric) - COALESCE(r.amount_repaid, 0::numeric)) > 0::numeric AS is_defaulter';

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'defaulter expression not found in the live view - inspect by hand';
  END IF;

  -- Same shape the other four use: term_end is the last billed day, so a plan
  -- is in default once today is past it and money is still owed.
  v_new := 'r.status = ANY (ARRAY[''funded''::text, ''repaying''::text]) '
        || 'AND (COALESCE(r.repayment_starts_on, (r.funded_at AT TIME ZONE ''Africa/Kampala''::text)::date) '
        || '+ COALESCE(r.duration_days, 0) - 1) < (now() AT TIME ZONE ''Africa/Kampala''::text)::date '
        || 'AND (COALESCE(r.total_repayment, 0::numeric) - COALESCE(r.amount_repaid, 0::numeric)) > 0::numeric AS is_defaulter';

  v_def := replace(v_def, v_old, v_new);

  EXECUTE 'CREATE OR REPLACE VIEW public.v_crm_call_section AS ' || v_def;
  RAISE NOTICE 'defaulter now measured from repayment_starts_on, live plans only';
END $fix$;

GRANT SELECT ON public.v_crm_call_section TO authenticated;

-- Verify --------------------------------------------------------------------
DO $verify$
DECLARE v_def text; v_defaulters bigint; v_notlive int; v_sections int;
BEGIN
  SELECT pg_get_viewdef('public.v_crm_call_section'::regclass, true) INTO v_def;

  IF position('repayment_starts_on' in v_def) = 0 THEN
    RAISE EXCEPTION 'the view still does not mention repayment_starts_on - rolled back';
  END IF;
  IF position('make_interval(days => COALESCE(r.duration_days, 0))' in v_def) > 0 THEN
    RAISE EXCEPTION 'the funded_at term test survived - rolled back';
  END IF;

  -- The rest of the view must be untouched: five queues, still no purged rows.
  SELECT count(DISTINCT section) INTO v_sections FROM public.v_crm_call_section;
  IF v_sections <> 5 THEN
    RAISE EXCEPTION 'expected 5 queues after the patch, found % - rolled back', v_sections;
  END IF;
  IF EXISTS (SELECT 1 FROM public.v_crm_call_section q
               JOIN public.profiles p ON p.id = q.person_id
              WHERE p.full_name ILIKE '%[DELETED]%' OR p.full_name ILIKE '%[ARCHIVED]%') THEN
    RAISE EXCEPTION 'purged accounts reappeared in a queue - rolled back';
  END IF;

  SELECT count(DISTINCT person_id) INTO v_defaulters
    FROM public.v_crm_call_section WHERE section='tenant' AND subtype='defaulter';
  IF v_defaulters = 0 THEN
    RAISE EXCEPTION 'no defaulters at all - the predicate is wrong, rolled back';
  END IF;

  -- Nobody whose plan is neither funded nor repaying may be a defaulter.
  SELECT count(*) INTO v_notlive
    FROM public.v_crm_call_section q
   WHERE q.section='tenant' AND q.subtype='defaulter'
     AND NOT EXISTS (SELECT 1 FROM public.rent_requests rr
                      WHERE rr.tenant_id = q.person_id
                        AND rr.status IN ('funded','repaying'));
  IF v_notlive > 0 THEN
    RAISE EXCEPTION '% defaulter(s) hold no live plan - rolled back', v_notlive;
  END IF;

  -- The tenant whose start was deferred yesterday must not be one.
  IF EXISTS (SELECT 1 FROM public.v_crm_call_section
              WHERE section='tenant' AND subtype='defaulter'
                AND person_id = '1a470d4a-41d9-48d8-ae84-9c6f3c583c23') THEN
    RAISE EXCEPTION 'Patience Ruba is still flagged a defaulter - rolled back';
  END IF;

  RAISE NOTICE 'defaulter measured from repayment start: % tenants, all on live plans', v_defaulters;
END $verify$;
