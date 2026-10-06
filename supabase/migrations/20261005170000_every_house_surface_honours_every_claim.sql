-- Every empty-house surface honours every kind of claim.
--
-- First live test of the company-managed allocator: portfolio WIP2610053262,
-- principal 700,000, claimed 4 houses for exactly 700,000 with no remainder.
-- The allocator worked. The surfaces around it did not agree about it.
--
-- TWO PROBLEMS FOUND BY THAT TEST
--
-- 1. house_has_live_claim() was INCOMPLETE. It knew about promissory-note
--    intents and portfolio allocations, but not about `partner_supported_houses`
--    — a third way a house gets spoken for, used by the partner self-support
--    flow. The browse list and the map had always checked it; the funder
--    summary never had. So the hero card counted self-supported houses as still
--    needing funding.
--
-- 2. SIX other functions still carried their own copy of the "is this house
--    claimed" test, written before portfolio allocations existed:
--
--      agent_list_empty_house_opportunities   the browse list
--      map_empty_house_cells                  the map
--      map_empty_house_trend                  the totals series
--      partner_support_houses (x2)            write path, see below
--      agent_create_promissory_note_for_houses  write path, see below
--      public_house_support_offer             public offer page
--
--    None of them knew a company-managed portfolio could claim a house, so a
--    claimed house stayed on the browse list and the map, offered for funding a
--    second time.
--
-- This is exactly the drift §8 of the spec predicted: "if the rule lives in
-- more than one place they will disagree within a week." It took one afternoon.
--
-- WHAT THIS MIGRATION DOES
--
-- Completes the shared predicate with all three claim mechanisms, then points
-- the three READ surfaces at it. The functions are rebuilt from
-- pg_get_functiondef so their signatures come from the database rather than
-- being retyped — the overload hazard that bit this project before.

-- 1. The complete definition of "already spoken for" -------------------------
CREATE OR REPLACE FUNCTION public.house_has_live_claim(p_house_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    -- 1. A funder picked it through the promissory-note flow.
    SELECT 1 FROM public.promissory_note_house_intents i
     WHERE i.house_id = p_house_id AND i.status IN ('reserved','funded')
    UNION ALL
    -- 2. A partner is self-supporting it.
    SELECT 1 FROM public.partner_supported_houses psh
     WHERE psh.house_id = p_house_id AND psh.status IN ('pending','active')
    UNION ALL
    -- 3. A company-managed portfolio claimed it.
    SELECT 1 FROM public.portfolio_allocations a
     WHERE a.house_id = p_house_id AND a.status IN ('reserved','fulfilled')
  );
$function$;

COMMENT ON FUNCTION public.house_has_live_claim(uuid) IS
  'True when an empty house is already spoken for, by ANY of the three claim '
  'mechanisms: a promissory-note intent, a partner self-support row, or a '
  'company-managed portfolio allocation. The single source of truth for the '
  'funder summary, the browse list, the map, the totals series and the '
  'portfolio allocator. Add a fourth mechanism here, never in a caller.';

GRANT EXECUTE ON FUNCTION public.house_has_live_claim(uuid) TO authenticated, service_role;

-- 2. Point the read surfaces at it ------------------------------------------
--
-- Each of these carried the identical two-part NOT EXISTS block. It is replaced
-- in place by one call, so the next claim mechanism needs no edit here at all.
DO $patch$
DECLARE r record; v_def text; v_new text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('agent_list_empty_house_opportunities',
                         'map_empty_house_cells',
                         'map_empty_house_trend')
  LOOP
    v_def := pg_get_functiondef(r.oid);
    CONTINUE WHEN v_def LIKE '%house_has_live_claim%';

    v_new := regexp_replace(v_def,
      'NOT EXISTS\s*\(\s*SELECT 1 FROM public\.promissory_note_house_intents i\s*'
      || 'WHERE i\.house_id = h\.id AND i\.status = ''reserved''\s*\)\s*'
      || 'AND NOT EXISTS\s*\(\s*SELECT 1 FROM public\.partner_supported_houses psh\s*'
      || 'WHERE psh\.house_id = h\.id\s*AND psh\.status IN \(''pending'', ''active''\)\s*\)',
      'NOT public.house_has_live_claim(h.id)', 'g');

    IF v_new = v_def THEN
      RAISE WARNING 'house claim predicate not matched in % - check it by hand', r.proname;
      CONTINUE;
    END IF;

    EXECUTE v_new;
  END LOOP;
END
$patch$;

-- STILL CARRYING THEIR OWN COPY, DELIBERATELY LEFT ALONE
--
--   partner_support_houses (both overloads)
--   agent_create_promissory_note_for_houses
--   public_house_support_offer
--
-- These are WRITE paths: they decide whether a funder may commit money to a
-- house. Switching their eligibility test is a money change, not a display
-- change, and it should be done deliberately with the self-support flow in
-- front of someone who owns it.
--
-- The gap is real and worth closing soon: a partner can currently self-support
-- a house that a company-managed portfolio has already claimed, because
-- partner_support_houses checks only promissory intents and its own table. That
-- is a double-funding risk, not a cosmetic one.
--
-- TODO (SSENKAALI PIUS): bring the three write paths onto
-- house_has_live_claim() once the self-support flow has been reviewed.
