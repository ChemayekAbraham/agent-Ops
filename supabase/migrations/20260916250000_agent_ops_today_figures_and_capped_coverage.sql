-- Make Agent Operations show today's numbers with arrears excluded.
--
-- THE COMPLAINT
-- "today's collections is like 51M yet expected is less". The 51M was correct.
-- What was wrong is that it sat next to a figure that means something else.
--
-- THREE SEPARATE DEFECTS, all in how the day is measured.
--
-- 1. TIMEZONE MISMATCH  (get_agent_ops_overview)
--    `v_today` is a Kampala date, but `collections_today` compared it against
--    `created_at::date` - a UTC cast. Different day boundaries entirely. On
--    2026-09-16 the UTC basis read 47,360,951 and the Kampala basis
--    51,072,299: a 3.7M discrepancy against a bill that is always a Kampala
--    day.
--
-- 2. INCOMPARABLE NUMERATOR  (get_agent_ops_overview)
--    `collections_today` is ALL cash in the door. Most of it is tenants
--    clearing older debt, which is real money but is not progress against
--    today's bill. Put beside `expected` it read as ~840% coverage. The key is
--    left as it was - it is not wrong, it answers a different question - and
--    the like-for-like figures are added alongside it:
--      expected_today, plans_billed_today,
--      collected_on_schedule_today  (capped per tenant)
--      pending_today                (expected - capped collected)
--
-- 3. PENDING CLAMPED TO ZERO  (get_agent_collections_coverage)
--    The overview's "Pending Collections" tile computed expected - collected
--    and clamped negatives to zero. It used the UNCAPPED on-schedule figure,
--    which counts every shilling paid against any plan billed in the window
--    however far above that plan's daily amount it goes. On 2026-09-16 that is
--    18,249,084 against a 6,080,933 bill, so the subtraction went negative and
--    the tile showed ZERO pending on a day with 4.3M genuinely outstanding.
--
--    Uncapped is the right basis for "how much cash arrived". It is the wrong
--    basis for "are agents keeping up", because one tenant overpaying covers
--    another who paid nothing. This adds the capped companions rather than
--    changing the existing keys, so nothing already reading them shifts:
--      collected_on_schedule_capped, pending_capped, coverage_pct_capped
--
-- VERIFIED against live data for 2026-09-16:
--   expected_due              6,080,933
--   collected_total          51,072,299   (all cash - correct, not comparable)
--   on_schedule UNCAPPED     18,249,084   (made pending read zero)
--   on_schedule CAPPED        1,801,579
--   pending CAPPED            4,279,354
--
-- Both functions were patched in place (pg_get_functiondef -> replace ->
-- EXECUTE) rather than restated, because both carry work that is not in this
-- repository and restating would clobber it.

-- 1. get_agent_ops_overview ------------------------------------------------
DO $ovw$
DECLARE v_def text; v_before text; v_add text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_agent_ops_overview';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_agent_ops_overview missing'; END IF;
  IF position('expected_today' in v_def) > 0 THEN
    RAISE NOTICE 'overview already patched'; RETURN;
  END IF;
  v_before := v_def;

  IF position('AND created_at::date = v_today)' in v_def) = 0 THEN
    RAISE EXCEPTION 'UTC-cast anchor not found - inspect by hand';
  END IF;

  v_def := replace(v_def, 'AND created_at::date = v_today)',
                          'AND (created_at AT TIME ZONE ''Africa/Kampala'')::date = v_today)');

  v_add :=
    '    -- Today measured against TODAY''S BILL. `collections_today` above is all' || chr(10) ||
    '    -- cash in the door and includes arrears, so it is NOT the numerator for' || chr(10) ||
    '    -- `expected_today`. Use these together, never as a single ratio.' || chr(10) ||
    '    ''expected_today'', (SELECT COALESCE(sum(expected_ugx),0)' || chr(10) ||
    '                          FROM public.agent_expected_day_plans WHERE day = v_today),' || chr(10) ||
    '    ''plans_billed_today'', (SELECT count(*) FROM public.agent_expected_day_plans WHERE day = v_today),' || chr(10) ||
    '    ''collected_on_schedule_today'', (SELECT COALESCE(sum(LEAST(COALESCE(p.paid,0), b.expected_ugx)),0)' || chr(10) ||
    '                          FROM public.agent_expected_day_plans b' || chr(10) ||
    '                          LEFT JOIN LATERAL (SELECT sum(ac.amount) AS paid FROM public.agent_collections ac' || chr(10) ||
    '                             WHERE ac.rent_request_id = b.rent_request_id AND ac.reversed_at IS NULL' || chr(10) ||
    '                               AND (ac.created_at AT TIME ZONE ''Africa/Kampala'')::date = v_today) p ON true' || chr(10) ||
    '                         WHERE b.day = v_today),' || chr(10) ||
    '    ''pending_today'', (SELECT COALESCE(sum(b.expected_ugx - LEAST(COALESCE(p.paid,0), b.expected_ugx)),0)' || chr(10) ||
    '                          FROM public.agent_expected_day_plans b' || chr(10) ||
    '                          LEFT JOIN LATERAL (SELECT sum(ac.amount) AS paid FROM public.agent_collections ac' || chr(10) ||
    '                             WHERE ac.rent_request_id = b.rent_request_id AND ac.reversed_at IS NULL' || chr(10) ||
    '                               AND (ac.created_at AT TIME ZONE ''Africa/Kampala'')::date = v_today) p ON true' || chr(10) ||
    '                         WHERE b.day = v_today),' || chr(10) ||
    '    ''collections_curr'',';

  v_def := replace(v_def, '    ''collections_curr'',', v_add);

  IF v_def = v_before THEN RAISE EXCEPTION 'nothing changed'; END IF;
  EXECUTE v_def;
  RAISE NOTICE 'get_agent_ops_overview patched';
END $ovw$;

-- 2. get_agent_collections_coverage ----------------------------------------
DO $cov$
DECLARE v_def text; v_before text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_agent_collections_coverage';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_agent_collections_coverage missing'; END IF;
  IF position('pending_capped' in v_def) > 0 THEN
    RAISE NOTICE 'coverage already patched'; RETURN;
  END IF;
  v_before := v_def;

  v_def := replace(v_def,
    '  ),' || chr(10) || '  cash as (',
    '  ),' || chr(10) ||
    '  bill_amt as (' || chr(10) ||
    '    select p.rent_request_id, sum(p.expected_ugx) as expected_ugx' || chr(10) ||
    '    from public.agent_expected_day_plans p' || chr(10) ||
    '    where p.day between v_d1 and v_asof' || chr(10) ||
    '    group by p.rent_request_id' || chr(10) ||
    '  ),' || chr(10) || '  cash as (');

  v_def := replace(v_def,
    '  ),' || chr(10) || '  per_agent as (',
    '  ),' || chr(10) ||
    '  capped as (' || chr(10) ||
    '    select coalesce(sum(least(coalesce(c.paid,0), b.expected_ugx)), 0) as on_schedule_capped,' || chr(10) ||
    '           coalesce(sum(b.expected_ugx - least(coalesce(c.paid,0), b.expected_ugx)), 0) as pending_capped' || chr(10) ||
    '    from bill_amt b' || chr(10) ||
    '    left join (select rent_request_id, sum(amount) as paid from cash group by rent_request_id) c' || chr(10) ||
    '           on c.rent_request_id = b.rent_request_id' || chr(10) ||
    '  ),' || chr(10) || '  per_agent as (');

  v_def := replace(v_def,
    '    ''coverage_basis'', ''uncapped_on_billed_plans'',',
    '    -- CAPPED at what each tenant owed. The uncapped figures above let one' || chr(10) ||
    '    -- tenant clearing arrears cover a tenant who paid nothing, so they can' || chr(10) ||
    '    -- exceed expected_due several times over and make "pending" read zero.' || chr(10) ||
    '    ''collected_on_schedule_capped'', (select on_schedule_capped from capped),' || chr(10) ||
    '    ''pending_capped'', (select pending_capped from capped),' || chr(10) ||
    '    ''coverage_pct_capped'', case when v_expected > 0' || chr(10) ||
    '                             then round(100.0 * (select on_schedule_capped from capped) / v_expected, 1)' || chr(10) ||
    '                             else null end,' || chr(10) ||
    '    ''coverage_basis'', ''uncapped_on_billed_plans'',');

  IF v_def = v_before THEN RAISE EXCEPTION 'no anchors matched'; END IF;
  EXECUTE v_def;
  RAISE NOTICE 'get_agent_collections_coverage patched';
END $cov$;

DO $verify$
BEGIN
  IF (SELECT position('expected_today' in prosrc) FROM pg_proc WHERE proname='get_agent_ops_overview') = 0
  THEN RAISE EXCEPTION 'overview missing the today figures'; END IF;
  IF (SELECT position('AND created_at::date = v_today' in prosrc) FROM pg_proc WHERE proname='get_agent_ops_overview') > 0
  THEN RAISE EXCEPTION 'overview still compares a Kampala date to a UTC cast'; END IF;
  IF (SELECT position('pending_capped' in prosrc) FROM pg_proc WHERE proname='get_agent_collections_coverage') = 0
  THEN RAISE EXCEPTION 'coverage missing the capped figures'; END IF;
  RAISE NOTICE 'today figures verified: Kampala basis, capped pending available';
END $verify$;
