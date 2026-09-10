-- Reversed collections were still being counted as collections.
--
-- THE DEFECT
-- When the 16 inverted collections were reversed on 2026-09-10, the reversal
-- was recorded by appending "[REVERSED: ...]" to `agent_collections.notes`.
-- The incident report then claimed "every tile that sums collections now
-- excludes them". That was wrong, and not checked.
--
-- Of the 97 database functions that read `agent_collections`, exactly TWO ever
-- looked for that substring. The other 95 sum `amount` and move on. So the
-- phantom money reappeared across the whole product. On Agent Ops > Overview,
-- 2026-09-10 13:40 EAT:
--
--   Total Collected      7.19M   (real: 1,203,462 - the rest was 5,991,036 of
--                                 reversed rows: Katongole 5,897,368 + Saka 93,668)
--   Pending Collections  UGX 0   (real: 3,495,377 - computed as
--                                 max(0, 4.70M expected - 7.15M "collected"),
--                                 so phantom money HID a genuine shortfall)
--   Top performer #1     Katongole James, 10 collections, 5.90M
--                                 (his genuine collections that day: zero)
--
-- No money moved twice. The ledger reversal held throughout - Katongole's float
-- is 178,700, exactly his real top-up, and the clawback legs are all present.
-- This was a reporting failure, but a consequential one: see the credit-limit
-- note at the end.
--
-- THE ROOT CAUSE is that a substring in a free-text field is not a data model.
-- Nothing forced a reader to honour it and nothing failed when they did not.

-- 1. Make the reversal a first-class fact ---------------------------------
ALTER TABLE public.agent_collections
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz;

COMMENT ON COLUMN public.agent_collections.reversed_at IS
  'Set when a collection has been reversed. Reporting MUST exclude these rows. Before '
  '2026-09-10 the only marker was a "[REVERSED:" substring inside notes, which 95 of the '
  '97 functions reading this table never checked.';

CREATE INDEX IF NOT EXISTS idx_agent_collections_live
  ON public.agent_collections (created_at DESC)
  WHERE reversed_at IS NULL;

-- 2. The float guard must not block maintaining those rows -----------------
-- `agent_collections_float_cannot_rise` (added earlier the same day) blocked
-- the backfill below: 15 of the 16 reversed rows carry the inverted float
-- columns the constraint exists to prevent. Exempting reversed rows lets their
-- metadata be maintained without rewriting audit values. Live rows stay strict
-- and ZERO live rows violate it.
ALTER TABLE public.agent_collections
  DROP CONSTRAINT IF EXISTS agent_collections_float_cannot_rise;

ALTER TABLE public.agent_collections
  ADD CONSTRAINT agent_collections_float_cannot_rise
  CHECK (
    collection_channel IS DISTINCT FROM 'agent_float'
    OR float_before IS NULL OR float_after IS NULL
    OR float_after <= float_before
    OR reversed_at IS NOT NULL
  ) NOT VALID;

COMMENT ON CONSTRAINT agent_collections_float_cannot_rise ON public.agent_collections IS
  'A collection spends the agent float, so float_after can never exceed float_before. Added '
  'after the 2026-09-10 inverted collection incident. Reversed rows are exempt.';

-- 3. Backfill from the note marker -----------------------------------------
UPDATE public.agent_collections
   SET reversed_at = created_at
 WHERE notes ILIKE '%[REVERSED:%'
   AND reversed_at IS NULL;

DO $verify$
DECLARE v_missed int;
BEGIN
  SELECT count(*) INTO v_missed FROM public.agent_collections
   WHERE notes ILIKE '%[REVERSED:%' AND reversed_at IS NULL;
  IF v_missed > 0 THEN
    RAISE EXCEPTION 'backfill missed % reversed rows', v_missed;
  END IF;
END
$verify$;

-- 4. Keep it true going forward --------------------------------------------
DO $m$
DECLARE v_def text; v_after text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='agent_reverse_tenant_allocation' LIMIT 1;

  IF v_def IS NULL THEN RAISE EXCEPTION 'agent_reverse_tenant_allocation not found'; END IF;
  IF position('reversed_at' in v_def) > 0 THEN
    RAISE NOTICE 'agent_reverse_tenant_allocation already sets reversed_at - skipping'; RETURN;
  END IF;

  -- Stamp the column alongside the note. The note stays for humans; the column
  -- is what reporting filters on.
  v_after := replace(v_def,
    'SET notes = COALESCE(notes, '''') || '' [REVERSED: '' || p_reason || '']''',
    'SET reversed_at = COALESCE(reversed_at, now()),' || E'\n' ||
    '      notes = COALESCE(notes, '''') || '' [REVERSED: '' || p_reason || '']''');

  -- The already-reversed guard checked a note substring, and checked for
  -- "[REVERSED]" while the writer emits "[REVERSED: reason]" - so it never
  -- matched. Check the column, and fix the substring too.
  v_after := replace(v_after,
    'IF COALESCE(v_collection.notes, '''') ILIKE ''%[REVERSED]%'' THEN',
    'IF v_collection.reversed_at IS NOT NULL OR COALESCE(v_collection.notes, '''') ILIKE ''%[REVERSED%'' THEN');

  IF position('SET reversed_at = COALESCE(reversed_at, now())' in v_after) = 0
     OR position('v_collection.reversed_at IS NOT NULL' in v_after) = 0 THEN
    RAISE EXCEPTION 'agent_reverse_tenant_allocation did not match the expected shape - refusing a partial patch';
  END IF;

  EXECUTE v_after;
END
$m$;

-- 5. The three functions behind Agent Ops > Overview and > Performance -----
-- Patched in place rather than restated: these are large, they are deployed
-- outside this repository, and a conditional patch is safe to re-run.

DO $m$
DECLARE v_def text; v_after text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_agent_collections_command_center' LIMIT 1;
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_agent_collections_command_center not found'; END IF;
  IF position('reversed_at' in v_def) > 0 THEN
    RAISE NOTICE 'command center already excludes reversed collections - skipping'; RETURN;
  END IF;

  v_after := replace(v_def, 'and ac.amount > 0',
                            'and ac.amount > 0 and ac.reversed_at is null');
  v_after := replace(v_after, 'where ac.rent_request_id is not null',
                              'where ac.rent_request_id is not null and ac.reversed_at is null');

  v_n := (length(v_after) - length(replace(v_after, 'ac.reversed_at is null', ''))) / length('ac.reversed_at is null');
  IF v_n <> 5 THEN RAISE EXCEPTION 'command center: expected 5 filters, produced %', v_n; END IF;
  EXECUTE v_after;
END
$m$;

DO $m$
DECLARE v_def text; v_after text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_agent_collections_coverage' LIMIT 1;
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_agent_collections_coverage not found'; END IF;
  IF position('reversed_at' in v_def) > 0 THEN
    RAISE NOTICE 'coverage already excludes reversed collections - skipping'; RETURN;
  END IF;

  v_after := replace(v_def, 'and ac.amount > 0',
                            'and ac.amount > 0 and ac.reversed_at is null');

  v_n := (length(v_after) - length(replace(v_after, 'ac.reversed_at is null', ''))) / length('ac.reversed_at is null');
  IF v_n <> 1 THEN RAISE EXCEPTION 'coverage: expected 1 filter, produced %', v_n; END IF;
  EXECUTE v_after;
END
$m$;

DO $m$
DECLARE v_def text; v_after text; v_n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_agent_ops_overview' LIMIT 1;
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_agent_ops_overview not found'; END IF;
  IF position('reversed_at' in v_def) > 0 THEN
    RAISE NOTICE 'overview already excludes reversed collections - skipping'; RETURN;
  END IF;

  -- 7 plain aggregates: collections_today (x2), _curr, _prev, counts, trend.
  v_after := replace(v_def,
    'FROM agent_collections WHERE created_at',
    'FROM agent_collections WHERE reversed_at IS NULL AND created_at');
  -- active_curr / active_prev (6-space indent)
  v_after := replace(v_after,
    E'FROM agent_collections\n      WHERE agent_id IS NOT NULL AND created_at',
    E'FROM agent_collections\n      WHERE agent_id IS NOT NULL AND reversed_at IS NULL AND created_at');
  -- active_bkt (8-space indent)
  v_after := replace(v_after,
    E'FROM agent_collections\n        WHERE agent_id IS NOT NULL AND created_at',
    E'FROM agent_collections\n        WHERE agent_id IS NOT NULL AND reversed_at IS NULL AND created_at');
  -- top performers `collected` CTE (5-space indent, predicate on its own line)
  v_after := replace(v_after,
    E'FROM agent_collections\n     WHERE agent_id IS NOT NULL\n       AND created_at',
    E'FROM agent_collections\n     WHERE agent_id IS NOT NULL\n       AND reversed_at IS NULL\n       AND created_at');

  v_n := (length(v_after) - length(replace(v_after, 'reversed_at IS NULL', ''))) / length('reversed_at IS NULL');
  IF v_n <> 11 THEN RAISE EXCEPTION 'overview: expected 11 filters, produced %', v_n; END IF;
  EXECUTE v_after;
END
$m$;

-- The agent-identity CTE in get_agent_ops_overview (`base_ts`) is deliberately
-- NOT filtered: it answers "when was this person first seen as an agent", not
-- "how much did they collect", and filtering it would move the agent counts
-- every other figure is compared against.

-- 6. Post-condition ---------------------------------------------------------
DO $verify$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('get_agent_ops_overview','get_agent_collections_command_center',
                       'get_agent_collections_coverage','agent_reverse_tenant_allocation')
     AND p.prosrc NOT ILIKE '%reversed_at%';

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'these still ignore reversed collections: %', v_bad;
  END IF;
END
$verify$;

-- STILL UNFILTERED, and reported rather than changed here: 93 other functions
-- read agent_collections without excluding reversed rows. Most are cosmetic;
-- these are not, because they size money:
--
--   recalculate_credit_limit          get_agent_advance_potential
--   get_agent_advance_limits          get_agent_advance_potential_for
--   get_agent_advance_repayment_monitor   recompute_agent_earned_vouch
--
-- CONFIRMED CONSEQUENCE. `recalculate_credit_limit` raises an agent's borrowing
-- limit by 6% of each collection. During the incident window (07:29:39 ->
-- 07:37:30 EAT) Katongole James's limit rose in ten steps from 792,853.52 to
-- 1,146,695.60 - exactly +353,842.08, which is 6% of the 5,897,368 he never
-- collected. That increase has NOT been reversed. Across all three agents
-- holding reversed rows the exposure is about 377,462:
--
--   Katongole James      5,897,368 reversed -> 353,842.08 (confirmed in the log)
--   Akampurira Onesmus     300,000 reversed ->  18,000.00 (not seen in the log)
--   Saka Homi Melvin        93,668 reversed ->   5,620.08 (log shows 12,020.16
--                                                 including genuine collections)
--
-- Correcting a live borrowing limit changes what an agent can draw, so it is
-- left for an explicit decision rather than applied here.
