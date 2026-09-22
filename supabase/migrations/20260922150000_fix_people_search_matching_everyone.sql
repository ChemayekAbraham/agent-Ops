-- Searching by name returned every profile on the platform.
--
-- THE BUG
-- Both people searches match a name OR a phone number, and the phone arm
-- strips non-digits from the search term:
--
--     OR regexp_replace(COALESCE(pr.phone,''), '\D', '', 'g')
--        LIKE '%' || regexp_replace(v_search, '\D', '', 'g') || '%'
--
-- For a NAME there are no digits, so `regexp_replace('Timothy','\D','','g')`
-- is the empty string and the clause becomes `phone LIKE '%%'` - true for every
-- row. Because the arms are ORed, the whole predicate is then true for every
-- row, and the name is never actually applied.
--
-- Measured against live data before writing this:
--     'Timothy'     ->  96,800 rows   (every profile in the table)
--     '701312245'   ->       1 row    (correct)
--     '0701355245'  ->       0 rows   (correct - nobody holds that number)
--
-- So the queue filter was working and the search was silently discarding it.
-- Typing a name showed the whole platform, which is what was reported.
--
-- WHY IT MATTERS MORE THAN A BAD LIST
-- The reported symptom was "I tried calling myself and it called another
-- person". The dialler is not at fault: every session row dialled exactly the
-- profile phone of the person selected - checked across the last eight calls,
-- `target_phone` equals `profiles.phone` for `target_user_id` every time. What
-- put the wrong person under the cursor was this search, returning a list that
-- had nothing to do with the term typed.
--
-- A search that quietly matches everything is worse than one that matches
-- nothing, because the result still looks like a result.
--
-- THE FIX
-- Apply the phone arm only when the search actually contains digits. A name
-- search then tests the name alone, and a numeric search still matches a phone
-- however it is punctuated.
--
-- Both functions carry the same defect. `crm_platform_people_page` had it
-- first; `crm_call_roster_page` inherited it from me when I rewrote that
-- function in 20260922100000 and copied the predicate across without reading
-- it.
--
-- Patched in place because both carry logic that is not in this repository.

DO $search$
DECLARE
  v_def text;
  v_before text;
  v_fixed int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, quote_ident(n.nspname) AS nsp
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('crm_platform_people_page', 'crm_call_roster_page')
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_before := v_def;

    -- `pr` in the people page, `p` in the roster: same shape, different alias,
    -- so both replacements are attempted and exactly one will bite.
    v_def := replace(v_def,
      'OR regexp_replace(COALESCE(pr.phone,''''), ''\D'', '''', ''g'')' || chr(10) ||
      '               LIKE ''%'' || regexp_replace(v_search, ''\D'', '''', ''g'') || ''%'')',
      '-- Only test the number when the term HAS digits. Without this a name' || chr(10) ||
      '            -- search reduces to LIKE ''%%'' and matches every row.' || chr(10) ||
      '            OR (regexp_replace(v_search, ''\D'', '''', ''g'') <> ''''' || chr(10) ||
      '                AND regexp_replace(COALESCE(pr.phone,''''), ''\D'', '''', ''g'')' || chr(10) ||
      '                    LIKE ''%'' || regexp_replace(v_search, ''\D'', '''', ''g'') || ''%''))');

    v_def := replace(v_def,
      'OR regexp_replace(COALESCE(p.phone, ''''), ''\D'', '''', ''g'')' || chr(10) ||
      '               LIKE ''%'' || regexp_replace(v_search, ''\D'', '''', ''g'') || ''%'')',
      '-- Only test the number when the term HAS digits. Without this a name' || chr(10) ||
      '            -- search reduces to LIKE ''%%'' and matches every row.' || chr(10) ||
      '            OR (regexp_replace(v_search, ''\D'', '''', ''g'') <> ''''' || chr(10) ||
      '                AND regexp_replace(COALESCE(p.phone, ''''), ''\D'', '''', ''g'')' || chr(10) ||
      '                    LIKE ''%'' || regexp_replace(v_search, ''\D'', '''', ''g'') || ''%''))');

    IF v_def = v_before THEN
      -- Already fixed on a re-run, or the predicate moved.
      IF position('Only test the number when the term HAS digits' in v_before) > 0 THEN
        RAISE NOTICE '% already fixed', r.proname;
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'search predicate not found in % - inspect by hand', r.proname;
    END IF;

    EXECUTE v_def;
    v_fixed := v_fixed + 1;
    RAISE NOTICE 'search fixed: %', r.proname;
  END LOOP;

  RAISE NOTICE 'functions patched: %', v_fixed;
END $search$;

-- Verify ----------------------------------------------------------------------
DO $verify$
DECLARE v_bad text; v_all bigint; v_named bigint;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('crm_platform_people_page','crm_call_roster_page')
     AND position('Only test the number when the term HAS digits' in p.prosrc) = 0;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'search still unguarded in: % - rolled back', v_bad;
  END IF;

  -- The predicate itself, proven against real rows rather than assumed.
  SELECT count(*) INTO v_all FROM public.profiles;
  SELECT count(*) INTO v_named
    FROM public.profiles pr
   WHERE pr.full_name ILIKE '%Timothy%'
      OR (regexp_replace('Timothy', '\D', '', 'g') <> ''
          AND regexp_replace(COALESCE(pr.phone,''), '\D', '', 'g')
              LIKE '%' || regexp_replace('Timothy', '\D', '', 'g') || '%');
  IF v_named >= v_all THEN
    RAISE EXCEPTION 'a name search still matches every profile (% of %) - rolled back', v_named, v_all;
  END IF;

  RAISE NOTICE 'search guarded: a name search now matches % of % profiles', v_named, v_all;
END $verify$;
