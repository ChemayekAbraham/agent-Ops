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

  v_new := 'r.status = ANY (ARRAY[''funded''::text, ''repaying''::text]) '
        || 'AND (COALESCE(r.repayment_starts_on, (r.funded_at AT TIME ZONE ''Africa/Kampala''::text)::date) '
        || '+ COALESCE(r.duration_days, 0) - 1) < (now() AT TIME ZONE ''Africa/Kampala''::text)::date '
        || 'AND (COALESCE(r.total_repayment, 0::numeric) - COALESCE(r.amount_repaid, 0::numeric)) > 0::numeric AS is_defaulter';

  v_def := replace(v_def, v_old, v_new);

  EXECUTE 'CREATE OR REPLACE VIEW public.v_crm_call_section AS ' || v_def;
  RAISE NOTICE 'defaulter now measured from repayment_starts_on, live plans only';
END $fix$;

GRANT SELECT ON public.v_crm_call_section TO authenticated;

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

  SELECT count(*) INTO v_notlive
    FROM public.v_crm_call_section q
   WHERE q.section='tenant' AND q.subtype='defaulter'
     AND NOT EXISTS (SELECT 1 FROM public.rent_requests rr
                      WHERE rr.tenant_id = q.person_id
                        AND rr.status IN ('funded','repaying'));
  IF v_notlive > 0 THEN
    RAISE EXCEPTION '% defaulter(s) hold no live plan - rolled back', v_notlive;
  END IF;

  IF EXISTS (SELECT 1 FROM public.v_crm_call_section
              WHERE section='tenant' AND subtype='defaulter'
                AND person_id = '1a470d4a-41d9-48d8-ae84-9c6f3c583c23') THEN
    RAISE EXCEPTION 'Patience Ruba is still flagged a defaulter - rolled back';
  END IF;

  RAISE NOTICE 'defaulter measured from repayment start: % tenants, all on live plans', v_defaulters;
END $verify$;